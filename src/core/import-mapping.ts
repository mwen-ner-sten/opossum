import { targetSchema, type CheckTemplate, type TargetConfig } from './config';
import { resolveChecksPartial, templatePlaceholders } from './templates';

/** A row of tabular input after every cell has been reduced to a trimmed string. */
export type ImportRow = Record<string, string>;

export type MappedField = 'id' | 'name' | 'host' | 'group' | 'description' | 'template' | 'enabled';
export const MAPPED_FIELDS: MappedField[] = [
  'host',
  'name',
  'id',
  'group',
  'description',
  'template',
  'enabled',
];

export interface ImportMapping {
  /** Source column for each target field. Only `host` is required. */
  columns: Partial<Record<MappedField, string | undefined>>;
  /** Fallbacks used when a mapped column is absent or a cell is blank. */
  defaults: {
    group?: string | undefined;
    template?: string | undefined;
    idPrefix?: string | undefined;
  };
  /** Template variable name → source column. */
  vars: Record<string, string>;
  /** Template variable name → value used when no column is mapped or the cell is blank. */
  varDefaults?: Record<string, string> | undefined;
}

export interface PartialTarget {
  row: number;
  targetId: string;
  /** Template variables still undefined; the inherited checks that need them were left out. */
  missing: string[];
}

export interface ImportRowIssue {
  row: number;
  message: string;
}

export interface BuiltTargets {
  targets: TargetConfig[];
  issues: ImportRowIssue[];
  /** Targets that import with some inherited checks missing until their variables are set. */
  partial: PartialTarget[];
}

const FIELD_PATTERNS: Array<[MappedField, RegExp]> = [
  ['host', /^(host|hostname|ip|ip[_ .-]?addr(ess)?|address|fqdn|target|server|device)$/i],
  ['name', /^(name|site|site[_ .-]?name|display([_ .-]?name)?|title|label|location[_ .-]?name)$/i],
  ['id', /^(id|target[_ .-]?id|site[_ .-]?(id|code)|code|key|identifier)$/i],
  ['group', /^(group|region|area|customer|client|zone|folder|category|location)$/i],
  ['description', /^(desc(ription)?|notes?|comments?|details?)$/i],
  ['template', /^(template|profile|role|kind|model|check[_ .-]?set)$/i],
  ['enabled', /^(enabled|active|monitor(ed)?)$/i],
];

/** The last dotted segment of a flattened column name, e.g. `Terminal.Host` → `Host`. */
const leaf = (column: string): string => column.trim().split('.').pop() ?? column;

/**
 * Guesses which columns hold which target fields; every unmatched column becomes a variable.
 * Whole-name matches win over matches on the last segment of a nested (dotted) name.
 */
export function autoDetectMapping(columns: string[]): ImportMapping {
  const mapping: ImportMapping = { columns: {}, defaults: {}, vars: {} };
  const used = new Set<string>();
  for (const [field, pattern] of FIELD_PATTERNS) {
    const column =
      columns.find((name) => !used.has(name) && pattern.test(name.trim())) ??
      columns.find((name) => !used.has(name) && pattern.test(leaf(name)));
    if (column) {
      mapping.columns[field] = column;
      used.add(column);
    }
  }
  for (const column of columns) {
    if (used.has(column)) continue;
    const key = slugify(column, '_');
    if (key && /^[a-zA-Z_]/.test(key)) mapping.vars[key] = column;
  }
  return mapping;
}

/** Lower-case identifier safe for a target ID or variable name. */
export function slugify(value: string, separator = '-'): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, 'g'), '')
    .slice(0, 80);
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on', 'enabled', 'active']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off', 'disabled', 'inactive']);

function cell(row: ImportRow, column: string | undefined): string {
  return column ? (row[column] ?? '').trim() : '';
}

/**
 * Turns tabular rows into targets according to the mapping. Rows that cannot become a valid
 * target are reported as issues instead of aborting the whole import.
 */
export function buildTargetsFromRows(
  rows: ImportRow[],
  mapping: ImportMapping,
  templates: CheckTemplate[],
): BuiltTargets {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const templateIds = new Set(templateById.keys());
  const targets: TargetConfig[] = [];
  const issues: ImportRowIssue[] = [];
  const partial: PartialTarget[] = [];
  const seenIds = new Set<string>();
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const host = cell(row, mapping.columns.host);
    if (!host) {
      issues.push({ row: rowNumber, message: 'No host value' });
      return;
    }
    const name = cell(row, mapping.columns.name) || host;
    const rawId = cell(row, mapping.columns.id) || slugify(name) || slugify(host);
    let id = `${mapping.defaults.idPrefix ?? ''}${rawId}`;
    if (seenIds.has(id)) {
      let suffix = 2;
      while (seenIds.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    const group = cell(row, mapping.columns.group) || mapping.defaults.group;
    const description = cell(row, mapping.columns.description);
    const template = cell(row, mapping.columns.template) || mapping.defaults.template;
    const enabledText = cell(row, mapping.columns.enabled).toLowerCase();
    const enabled = FALSE_VALUES.has(enabledText)
      ? false
      : TRUE_VALUES.has(enabledText) || !enabledText;
    if (template && !templateIds.has(template)) {
      issues.push({ row: rowNumber, message: `Unknown template "${template}"` });
      return;
    }
    if (!template) {
      issues.push({
        row: rowNumber,
        message: 'No template assigned, so the target would have no checks',
      });
      return;
    }
    const vars: Record<string, string> = {};
    for (const [key, column] of Object.entries(mapping.vars)) {
      const value = cell(row, column);
      if (value !== '') vars[key] = value;
    }
    for (const [key, value] of Object.entries(mapping.varDefaults ?? {}))
      if (vars[key] === undefined && value.trim() !== '') vars[key] = value.trim();
    const parsed = targetSchema.safeParse({
      id,
      name,
      host,
      ...(group ? { group } : {}),
      ...(description ? { description } : {}),
      enabled,
      template,
      ...(Object.keys(vars).length ? { vars } : {}),
      checks: [],
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      issues.push({
        row: rowNumber,
        message: `${issue?.path.join('.') ?? 'target'}: ${issue?.message ?? 'invalid'}`,
      });
      return;
    }
    // Expand the template now: a bad URL is a row issue, a missing variable makes the row partial.
    try {
      const { missing } = resolveChecksPartial(parsed.data, templateById.get(template));
      if (missing.length) partial.push({ row: rowNumber, targetId: id, missing });
    } catch (error) {
      issues.push({
        row: rowNumber,
        message: error instanceof Error ? error.message : 'Template could not be applied',
      });
      return;
    }
    seenIds.add(id);
    targets.push(parsed.data);
  });
  return { targets, issues, partial };
}

/** Variable names a template reads via `{{vars.<name>}}`, for the mapping UI. */
export function templateVariables(template: CheckTemplate | undefined): string[] {
  if (!template) return [];
  return templatePlaceholders(template)
    .filter((name) => name.startsWith('vars.'))
    .map((name) => name.slice('vars.'.length));
}
