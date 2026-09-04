import { z } from 'zod';
import {
  checkSchema,
  checkTemplateSchema,
  validateDependencies,
  type CheckConfig,
  type CheckTemplate,
  type TargetConfig,
  type TemplateCheckConfig,
} from './config';

/** The subset of a target that placeholders can read. */
export type TemplateContext = Pick<TargetConfig, 'id' | 'name' | 'host' | 'group' | 'vars'>;

export interface TemplateIssue {
  checkId: string;
  path: string;
  message: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*\}\}/g;
const SAMPLE_CONTEXT: TemplateContext = {
  id: 'sample',
  name: 'Sample target',
  host: 'example.internal',
  group: 'Sample',
};

export class PlaceholderError extends Error {
  constructor(readonly placeholder: string) {
    super(`Unknown placeholder {{${placeholder}}}`);
  }
}

/** Every placeholder name referenced anywhere in a template, in first-seen order. */
export function templatePlaceholders(template: CheckTemplate): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]!);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(template.checks);
  return [...found];
}

export interface PlaceholderUsage {
  /** Placeholder name without braces, e.g. `vars.web_port`. */
  name: string;
  checkId: string;
  checkName: string;
  /** Dotted field path inside the check, e.g. `url` or `headers.Host`. */
  field: string;
  /** The full field value the placeholder sits in. */
  value: string;
}

/**
 * Every place a template reads a placeholder, so the UI can explain what a variable is for
 * ("web_port is used by EBO WebStation in url: https://{{host}}:{{vars.web_port}}/").
 */
export function placeholderUsages(template: Pick<CheckTemplate, 'checks'>): PlaceholderUsage[] {
  const usages: PlaceholderUsage[] = [];
  const visit = (check: TemplateCheckConfig, value: unknown, path: string[]): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER))
        usages.push({
          name: match[1]!,
          checkId: check.id,
          checkName: check.name,
          field: path.join('.'),
          value,
        });
    } else if (Array.isArray(value))
      value.forEach((item, index) => visit(check, item, [...path, String(index)]));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) visit(check, item, [...path, key]);
  };
  for (const check of template.checks) visit(check, check, []);
  return usages;
}

function resolve(name: string, context: TemplateContext): string {
  switch (name) {
    case 'host':
      return context.host;
    case 'name':
      return context.name;
    case 'id':
      return context.id;
    case 'group':
      return context.group ?? '';
  }
  if (name.startsWith('vars.')) {
    const key = name.slice('vars.'.length);
    const value = context.vars?.[key];
    if (value === undefined) throw new PlaceholderError(name);
    return value;
  }
  throw new PlaceholderError(name);
}

/** Replaces `{{...}}` placeholders in a string. Throws on an unknown or missing placeholder. */
export function substitute(text: string, context: TemplateContext): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => resolve(name, context));
}

function substituteDeep<T>(value: T, context: TemplateContext): T {
  if (typeof value === 'string') return substitute(value, context) as T;
  if (Array.isArray(value))
    return (value as unknown[]).map((item) => substituteDeep(item, context)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteDeep(item, context)]),
    ) as T;
  return value;
}

/**
 * Produces the concrete checks a target inherits from a template. Each check is tagged with
 * `from_template` so the editor can show it as read-only and storage can regenerate it.
 */
export function expandTemplate(template: CheckTemplate, context: TemplateContext): CheckConfig[] {
  return template.checks.map((check) => {
    let expanded: TemplateCheckConfig;
    try {
      expanded = substituteDeep(check, context);
    } catch (error) {
      if (error instanceof PlaceholderError) throw error;
      throw new Error(
        `Template "${template.id}" check "${check.id}": ${error instanceof Error ? error.message : 'invalid'}`,
        { cause: error },
      );
    }
    const parsed = checkSchema.safeParse({ ...expanded, from_template: template.id });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `Template "${template.id}" check "${check.id}" is invalid for ${context.host}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim(),
      );
    }
    return parsed.data;
  });
}

/**
 * Validates a template definition and expands it against a sample target so URL and
 * placeholder mistakes are reported before the template is saved.
 */
export function validateTemplate(input: unknown): {
  template?: CheckTemplate;
  issues: TemplateIssue[];
} {
  const parsed = checkTemplateSchema.safeParse(input);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map((issue) => ({
        checkId: typeof issue.path[1] === 'number' ? String(issue.path[1]) : '',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  const template = parsed.data;
  const issues: TemplateIssue[] = [];
  const vars = Object.fromEntries(
    templatePlaceholders(template)
      .filter((name) => name.startsWith('vars.'))
      .map((name) => [name.slice('vars.'.length), '1']),
  );
  for (const check of template.checks) {
    try {
      expandTemplate({ ...template, checks: [check] }, { ...SAMPLE_CONTEXT, vars });
    } catch (error) {
      issues.push({
        checkId: check.id,
        path: `checks.${check.id}`,
        message: error instanceof Error ? error.message : 'Template check is invalid',
      });
    }
  }
  return issues.length ? { issues } : { template, issues };
}

/** Own checks are the ones the user defined on the target itself, never inherited ones. */
export function ownChecks(target: TargetConfig): CheckConfig[] {
  return target.checks.filter((check) => !check.from_template);
}

/**
 * Merges own checks into the template's step order: each template step is replaced by an own
 * check with the same ID (so users can override one step), then own checks that add new steps
 * follow in their own order. Template steps come first because own checks may wait on them.
 */
export function mergeInTemplateOrder(
  templateChecks: ReadonlyArray<{ id: string }>,
  own: CheckConfig[],
  inherited: CheckConfig[],
): CheckConfig[] {
  const ownById = new Map(own.map((check) => [check.id, check]));
  const inheritedById = new Map(inherited.map((check) => [check.id, check]));
  const ordered = templateChecks.flatMap((step) => {
    const check = ownById.get(step.id) ?? inheritedById.get(step.id);
    return check ? [check] : [];
  });
  const placed = new Set(ordered.map((check) => check.id));
  return [...ordered, ...own.filter((check) => !placed.has(check.id))];
}

/**
 * Effective checks for a target in step order: template steps (an own check with the same ID
 * overrides the inherited one in place), then the target's own additional checks.
 */
export function resolveChecks(
  target: TargetConfig,
  template: CheckTemplate | undefined,
): CheckConfig[] {
  const own = ownChecks(target);
  if (!template) return own;
  const taken = new Set(own.map((check) => check.id));
  const inherited = expandTemplate(template, target).filter((check) => !taken.has(check.id));
  const effective = mergeInTemplateOrder(template.checks, own, inherited);
  const issue = validateDependencies(effective)[0];
  if (issue) throw new Error(`Check "${issue.checkId}": ${issue.message}`);
  return effective;
}

export interface PartialResolution {
  checks: CheckConfig[];
  /** Variable names the template reads that this target does not define. */
  missing: string[];
}

/** Variable names a template reads via `{{vars.<name>}}` that the target has not defined. */
export function missingTemplateVariables(
  target: Pick<TargetConfig, 'vars'>,
  template: CheckTemplate | undefined,
): string[] {
  if (!template) return [];
  return templatePlaceholders(template)
    .filter((name) => name.startsWith('vars.'))
    .map((name) => name.slice('vars.'.length))
    .filter((name) => target.vars?.[name] === undefined);
}

/**
 * Like {@link resolveChecks}, but inherited checks that cannot expand because a variable is
 * missing are left out instead of failing, so a partially configured target can be saved and
 * finished later. Other expansion errors still throw.
 */
export function resolveChecksPartial(
  target: TargetConfig,
  template: CheckTemplate | undefined,
): PartialResolution {
  const own = ownChecks(target);
  if (!template) return { checks: own, missing: [] };
  const taken = new Set(own.map((check) => check.id));
  const inherited: CheckConfig[] = [];
  const missing = new Set<string>();
  for (const check of template.checks) {
    if (taken.has(check.id)) continue;
    try {
      inherited.push(...expandTemplate({ ...template, checks: [check] }, target));
    } catch (error) {
      if (error instanceof PlaceholderError && error.placeholder.startsWith('vars.'))
        missing.add(error.placeholder.slice('vars.'.length));
      else throw error;
    }
  }
  const effective = mergeInTemplateOrder(template.checks, own, inherited);
  // Dependencies on a check that could not expand are dropped rather than rejected.
  const present = new Set(effective.map((check) => check.id));
  const checks = effective.map((check) =>
    check.depends_on?.some((id) => !present.has(id))
      ? { ...check, depends_on: check.depends_on.filter((id) => present.has(id)) }
      : check,
  );
  const issue = validateDependencies(checks)[0];
  if (issue) throw new Error(`Check "${issue.checkId}": ${issue.message}`);
  return { checks, missing: [...missing] };
}

export const templateContextSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  group: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
});
