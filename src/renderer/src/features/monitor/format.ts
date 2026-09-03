import type { CheckConfig } from '@core/config';
import type { CheckStatus } from '@core/models';

export const STATUS_ORDER: Record<CheckStatus, number> = {
  FAIL: 0,
  CHECKING: 1,
  UNKNOWN: 2,
  PAUSED: 3,
  PASS: 4,
};

export const keyFor = (targetId: string, checkId: string): string => `${targetId}\0${checkId}`;

export function formatDuration(value?: number): string {
  if (value === undefined) return '—';
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

export function formatClock(value?: string): string {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
}

/** Compact relative time such as "12 s ago" or "in 3 min"; falls back to a clock past a day. */
export function formatRelative(value: string | undefined, now: number): string {
  if (!value) return '—';
  const delta = Math.round((new Date(value).getTime() - now) / 1000);
  const abs = Math.abs(delta);
  if (abs >= 86_400) return formatClock(value);
  const text =
    abs < 60
      ? `${abs} s`
      : abs < 3_600
        ? `${Math.floor(abs / 60)} min`
        : `${Math.floor(abs / 3_600)} h ${Math.floor((abs % 3_600) / 60)} min`;
  return delta <= 0 ? `${text} ago` : `in ${text}`;
}

export function expectedStatusText(check: CheckConfig): string {
  if (check.type !== 'http') return '';
  return Array.isArray(check.expected_status)
    ? check.expected_status.join(', ')
    : String(check.expected_status);
}

/** Fraction of the check's timeout consumed by the last result, clamped to 0..1. */
export function latencyRatio(durationMs: number | undefined, timeoutSeconds: number): number {
  if (durationMs === undefined || timeoutSeconds <= 0) return 0;
  return Math.min(1, durationMs / (timeoutSeconds * 1_000));
}
