import type { CheckConfig, TemplateCheckConfig } from '@core/config';

/** Either a concrete check or a template check; the form fields are identical. */
export type EditableCheck = CheckConfig | TemplateCheckConfig;

export function parseHeaders(source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of source.split('\n')) {
    const split = line.indexOf(':');
    if (split > 0) headers[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return headers;
}

/** Builds a check of the requested type, carrying over the common fields from `current`. */
export function retypeCheck(
  current: EditableCheck,
  type: EditableCheck['type'],
  defaultHost: string,
): EditableCheck {
  const common = {
    id: current.id,
    name: current.name,
    enabled: current.enabled,
    tags: current.tags,
    ...(current.interval_seconds ? { interval_seconds: current.interval_seconds } : {}),
    ...(current.timeout_seconds ? { timeout_seconds: current.timeout_seconds } : {}),
    ...(current.failures_before_fail ? { failures_before_fail: current.failures_before_fail } : {}),
  };
  if (type === 'ping') return { ...common, type };
  if (type === 'tcp') return { ...common, type, port: 443 };
  return {
    ...common,
    type,
    url: `https://${defaultHost}/`,
    method: 'GET',
    expected_status: '200-399',
    headers: {},
    verify_tls: true,
    follow_redirects: true,
  };
}

export const newPingCheck = (): EditableCheck => ({
  id: 'host-ping',
  name: 'Host ping',
  type: 'ping',
  enabled: true,
  tags: [],
});

/**
 * Drops any dependency that no longer points at an earlier step, so reordering never leaves a
 * check waiting on something below it.
 */
export function normalizeDependencies(
  checks: EditableCheck[],
  inheritedIds: readonly string[],
): EditableCheck[] {
  const earlier = new Set(inheritedIds);
  return checks.map((check) => {
    const kept = (check.depends_on ?? []).filter((id) => earlier.has(id));
    earlier.add(check.id);
    if (kept.length === (check.depends_on?.length ?? 0)) return check;
    return { ...check, depends_on: kept.length ? kept : undefined };
  });
}
