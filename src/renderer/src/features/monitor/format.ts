import type { CheckConfig } from '@core/config';
import type { CheckStatus, LiveCheckState } from '@core/models';

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

/** How long a status has been held, e.g. "4 min" or "2 h 05 min"; undefined under a minute. */
export function formatHeld(since: string | undefined, now: number): string | undefined {
  if (!since) return undefined;
  const seconds = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  if (seconds < 60) return undefined;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400)
    return `${Math.floor(seconds / 3_600)} h ${String(Math.floor((seconds % 3_600) / 60)).padStart(2, '0')} min`;
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3_600)} h`;
}

export type CheckStatusCounts = Record<CheckStatus, number> & { blocked: number };

/** One-line summary of a target's checks, e.g. "2 failing · 1 blocked · 3 passing". */
export function summarizeStatuses(counts: CheckStatusCounts): string {
  const failing = counts.FAIL - counts.blocked;
  const parts = [
    failing > 0 ? `${failing} failing` : '',
    counts.blocked > 0 ? `${counts.blocked} blocked` : '',
    counts.CHECKING > 0 ? `${counts.CHECKING} checking` : '',
    counts.UNKNOWN > 0 ? `${counts.UNKNOWN} unknown` : '',
    counts.PAUSED > 0 ? `${counts.PAUSED} paused` : '',
  ].filter(Boolean);
  const total = counts.FAIL + counts.CHECKING + counts.UNKNOWN + counts.PAUSED + counts.PASS;
  if (parts.length === 0) return total === 0 ? 'No checks' : 'All passing';
  if (counts.PASS > 0) parts.push(`${counts.PASS} passing`);
  return parts.join(' · ');
}

export function countStatuses(states: readonly LiveCheckState[]): CheckStatusCounts {
  const counts: CheckStatusCounts = {
    PASS: 0,
    FAIL: 0,
    CHECKING: 0,
    UNKNOWN: 0,
    PAUSED: 0,
    blocked: 0,
  };
  for (const state of states) {
    counts[state.status] += 1;
    if (state.status === 'FAIL' && state.result?.category === 'blocked') counts.blocked += 1;
  }
  return counts;
}
