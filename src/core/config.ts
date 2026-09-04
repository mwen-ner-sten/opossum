import { z } from 'zod';

const idSchema = z
  .string()
  .min(1, 'Required')
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Use letters, numbers, dots, dashes, or underscores');
const positiveSeconds = z.number().int().min(1).max(86_400);

const HOSTNAME_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:.]+$/;

/**
 * Accepts an IPv4 address, an IPv6 address, or an RFC 1123 hostname. Rejecting anything else
 * (including a leading dash) guarantees the value can never be interpreted as a flag by ping.exe.
 */
export function isValidHost(host: string): boolean {
  if (IPV4.test(host)) return true;
  if (/^[\d.]+$/.test(host)) return false; // numeric-only but not a valid IPv4 address
  if (host.includes(':')) return IPV6.test(host) && host.split(':').length <= 8;
  const labels = host.replace(/\.$/, '').split('.');
  return labels.length > 0 && labels.every((label) => HOSTNAME_LABEL.test(label));
}

export const appSettingsSchema = z.object({
  default_interval_seconds: positiveSeconds.default(60),
  default_timeout_seconds: positiveSeconds.max(300).default(5),
  max_concurrent_checks: z.number().int().min(1).max(200).default(20),
  history_max_age_days: z.number().int().min(0).max(3650).default(180),
  history_max_database_mb: z.number().int().min(0).max(102_400).default(250),
  maintenance_on_startup: z.boolean().default(true),
  /**
   * Longest gap between runs of a check that keeps failing. Each further failure doubles the
   * interval up to this cap; 0 disables backoff so failing checks keep their normal interval.
   */
  failure_backoff_max_seconds: z.number().int().min(0).max(86_400).default(600),
});

const commonCheckFields = {
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(true),
  interval_seconds: positiveSeconds.optional(),
  timeout_seconds: positiveSeconds.max(300).optional(),
  /** Consecutive failures required before a check transitions to FAIL. Defaults to 1. */
  failures_before_fail: z.number().int().min(1).max(10).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  /**
   * IDs of checks on the same target that must currently PASS before this one runs. When a
   * precursor fails, this check records a "blocked" failure without touching the network.
   */
  depends_on: z.array(idSchema).max(10).optional(),
  /** Set on checks generated from a linked template; such checks are read-only on the target. */
  from_template: idSchema.optional(),
};
export const idPattern = idSchema;

export const pingCheckSchema = z.object({ ...commonCheckFields, type: z.literal('ping') }).strict();
export const tcpCheckSchema = z
  .object({
    ...commonCheckFields,
    type: z.literal('tcp'),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();
const expectedStatusSchema = z.union([
  z.number().int().min(100).max(599),
  z.array(z.number().int().min(100).max(599)).min(1),
  z.string().regex(/^[1-5]\d\d-[1-5]\d\d$/, 'Expected a status range such as 200-399'),
]);
const authSchema = z
  .object({
    type: z.enum(['basic', 'digest']),
    username_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i),
    password_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i),
  })
  .strict();
const strictUrl = z.url().refine((url) => {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}, 'Use a valid HTTP or HTTPS URL');
/** Template URLs may hold placeholders, so only the scheme is checked before expansion. */
const templateUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .regex(/^https?:\/\//i, 'Use HTTP or HTTPS');

function buildHttpCheckSchema<U extends z.ZodType<string>>(url: U) {
  return z
    .object({
      ...commonCheckFields,
      type: z.literal('http'),
      url,
      method: z.enum(['GET', 'HEAD']).default('GET'),
      expected_status: expectedStatusSchema.default('200-399'),
      contains: z.string().max(10_000).optional(),
      not_contains: z.string().max(10_000).optional(),
      headers: z.record(z.string(), z.string().max(4_096)).default({}),
      verify_tls: z.boolean().default(true),
      follow_redirects: z.boolean().default(true),
      auth: authSchema.optional(),
    })
    .strict()
    .superRefine((check, context) => {
      for (const header of Object.keys(check.headers)) {
        if (/^(authorization|cookie|proxy-authorization)$/i.test(header)) {
          context.addIssue({
            code: 'custom',
            path: ['headers', header],
            message: 'Secret headers are not allowed',
          });
        }
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) {
          context.addIssue({
            code: 'custom',
            path: ['headers', header],
            message: 'Invalid HTTP header name',
          });
        }
      }
    });
}
export const httpCheckSchema = buildHttpCheckSchema(strictUrl);
export const httpTemplateCheckSchema = buildHttpCheckSchema(templateUrl);

export const checkSchema = z.discriminatedUnion('type', [
  pingCheckSchema,
  tcpCheckSchema,
  httpCheckSchema,
]);

/** A check inside a template: identical to a check, except the URL may contain placeholders. */
export const templateCheckSchema = z.discriminatedUnion('type', [
  pingCheckSchema,
  tcpCheckSchema,
  httpTemplateCheckSchema,
]);

function uniqueCheckIds(checks: Array<{ id: string }>, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  checks.forEach((check, index) => {
    if (seen.has(check.id)) {
      context.addIssue({
        code: 'custom',
        path: ['checks', index, 'id'],
        message: `Duplicate check ID "${check.id}"`,
      });
    }
    seen.add(check.id);
  });
}

export interface DependencyIssue {
  checkId: string;
  message: string;
}

/**
 * Verifies that every `depends_on` entry names an *earlier* check in the same list. Checks are
 * ordered steps: a step may only wait on steps before it, which keeps the graph acyclic by
 * construction and lets the editor present dependencies as "runs after step N".
 */
export function validateDependencies(
  checks: ReadonlyArray<{ id: string; depends_on?: string[] | undefined }>,
): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  const position = new Map(checks.map((check, index) => [check.id, index]));
  checks.forEach((check, index) => {
    for (const dependency of check.depends_on ?? []) {
      const precursor = position.get(dependency);
      if (dependency === check.id)
        issues.push({ checkId: check.id, message: 'A check cannot depend on itself' });
      else if (precursor === undefined)
        issues.push({ checkId: check.id, message: `Depends on unknown check "${dependency}"` });
      else if (precursor > index)
        issues.push({
          checkId: check.id,
          message: `Step ${index + 1} can only wait on earlier steps; "${dependency}" is step ${precursor + 1}. Move it above this check.`,
        });
    }
  });
  return issues;
}

function dependencyIssues(
  checks: ReadonlyArray<{ id: string; depends_on?: string[] | undefined }>,
  context: z.RefinementCtx,
): void {
  for (const issue of validateDependencies(checks)) {
    const index = checks.findIndex((check) => check.id === issue.checkId);
    context.addIssue({
      code: 'custom',
      path: ['checks', index, 'depends_on'],
      message: issue.message,
    });
  }
}

/**
 * A reusable set of checks. Targets that link to a template inherit every check in it with
 * `{{host}}`, `{{name}}`, `{{id}}`, `{{group}}`, and `{{vars.<key>}}` substituted per target.
 */
export const checkTemplateSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).optional(),
    checks: z.array(templateCheckSchema).min(1),
  })
  .strict()
  .superRefine((template, context) => {
    uniqueCheckIds(template.checks, context);
    dependencyIssues(template.checks, context);
  });

const varsSchema = z
  .record(
    z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Variable names use letters, digits, underscores'),
    z.string().max(500),
  )
  .refine((vars) => Object.keys(vars).length <= 30, 'At most 30 variables per target');

export const targetSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    host: z.string().trim().min(1).max(253).refine(isValidHost, 'Invalid hostname or IP address'),
    group: z.string().trim().max(100).optional(),
    description: z.string().trim().max(2_000).optional(),
    enabled: z.boolean().default(true),
    /** ID of a template whose checks this target inherits. */
    template: idSchema.optional(),
    /** Per-target values available to template placeholders as `{{vars.<key>}}`. */
    vars: varsSchema.optional(),
    checks: z.array(checkSchema),
  })
  .strict()
  .superRefine((target, context) => {
    uniqueCheckIds(target.checks, context);
    // With a template linked, dependencies may point at inherited checks; storage validates
    // the combined set after expansion.
    if (!target.template) dependencyIssues(target.checks, context);
    if (target.checks.length === 0 && !target.template)
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'Add at least one check or link a template',
      });
  });

export const portableConfigurationSchema = z
  .object({
    format_version: z.literal(1),
    exported_at: z.iso.datetime({ offset: true }),
    application_version: z.string().min(1),
    app: appSettingsSchema,
    templates: z.array(checkTemplateSchema).default([]),
    targets: z.array(targetSchema),
  })
  .strict()
  .superRefine((configuration, context) => {
    const templateIds = new Set<string>();
    configuration.templates.forEach((template, index) => {
      if (templateIds.has(template.id))
        context.addIssue({
          code: 'custom',
          path: ['templates', index, 'id'],
          message: `Duplicate template ID "${template.id}"`,
        });
      templateIds.add(template.id);
    });
    const seen = new Set<string>();
    configuration.targets.forEach((target, index) => {
      if (seen.has(target.id)) {
        context.addIssue({
          code: 'custom',
          path: ['targets', index, 'id'],
          message: `Duplicate target ID "${target.id}"`,
        });
      }
      seen.add(target.id);
    });
  });

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type PingCheckConfig = z.infer<typeof pingCheckSchema>;
export type TcpCheckConfig = z.infer<typeof tcpCheckSchema>;
export type HttpCheckConfig = z.infer<typeof httpCheckSchema>;
export type CheckConfig = z.infer<typeof checkSchema>;
export type TemplateCheckConfig = z.infer<typeof templateCheckSchema>;
export type CheckTemplate = z.infer<typeof checkTemplateSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type PortableConfiguration = z.infer<typeof portableConfigurationSchema>;

export const DEFAULT_SETTINGS: AppSettings = appSettingsSchema.parse({});

export function effectiveInterval(check: CheckConfig, settings: AppSettings): number {
  return check.interval_seconds ?? settings.default_interval_seconds;
}

export function effectiveTimeout(check: CheckConfig, settings: AppSettings): number {
  return check.timeout_seconds ?? settings.default_timeout_seconds;
}

export function effectiveFailureThreshold(check: CheckConfig): number {
  return check.failures_before_fail ?? 1;
}

export function isExpectedHttpStatus(
  expected: HttpCheckConfig['expected_status'],
  status: number,
): boolean {
  if (typeof expected === 'number') return expected === status;
  if (Array.isArray(expected)) return expected.includes(status);
  const [start, end] = expected.split('-').map(Number);
  return start !== undefined && end !== undefined && status >= start && status <= end;
}
