import type { CheckConfig, TargetConfig } from './config';
import type { LiveCheckState } from './models';

/**
 * How a check compares with its last result from before this session. After a patch window,
 * "broke" is the question that matters: it passed before and fails now.
 */
export type Verdict =
  'broke' | 'still_failing' | 'new_failure' | 'blocked' | 'recovered' | 'ok' | 'pending' | 'paused';

export const VERDICT_ORDER: readonly Verdict[] = [
  'broke',
  'still_failing',
  'new_failure',
  'blocked',
  'recovered',
  'pending',
  'ok',
  'paused',
];

export const VERDICT_LABELS: Record<Verdict, string> = {
  broke: 'Broke',
  still_failing: 'Still failing',
  new_failure: 'Failing, no earlier result',
  blocked: 'Not run, prerequisite failing',
  recovered: 'Recovered',
  ok: 'OK',
  pending: 'Not checked yet',
  paused: 'Paused',
};

export function checkVerdict(state: LiveCheckState | undefined): Verdict {
  if (state?.status === 'PAUSED') return 'paused';
  // A last-known result belongs to an earlier session; only this session's results count.
  const current = state && !state.isHistorical ? state.result : undefined;
  if (!current) return 'pending';
  // Dependents of a failing check are never probed; counting them as regressions would turn
  // one dead host into several breakages.
  if (current.status === 'FAIL' && current.category === 'blocked') return 'blocked';
  const before = state?.lastKnown?.result.status;
  if (current.status === 'PASS') return before === 'FAIL' ? 'recovered' : 'ok';
  if (before === 'PASS') return 'broke';
  return before === 'FAIL' ? 'still_failing' : 'new_failure';
}

export interface VerdictSummary {
  counts: Record<Verdict, number>;
  /** Checks that are not paused. */
  active: number;
  /** Oldest and newest baseline result, so an operator can tell how stale "before" is. */
  baselineFrom?: string;
  baselineTo?: string;
}

export function summarizeVerdicts(states: Iterable<LiveCheckState | undefined>): VerdictSummary {
  const counts = Object.fromEntries(VERDICT_ORDER.map((verdict) => [verdict, 0])) as Record<
    Verdict,
    number
  >;
  let baselineFrom: string | undefined;
  let baselineTo: string | undefined;
  for (const state of states) {
    const verdict = checkVerdict(state);
    counts[verdict] += 1;
    const at = state?.lastKnown?.result.completedAt;
    if (verdict === 'paused' || !at) continue;
    if (!baselineFrom || at < baselineFrom) baselineFrom = at;
    if (!baselineTo || at > baselineTo) baselineTo = at;
  }
  return {
    counts,
    active: VERDICT_ORDER.reduce((sum, verdict) => sum + counts[verdict], 0) - counts.paused,
    ...(baselineFrom ? { baselineFrom } : {}),
    ...(baselineTo ? { baselineTo } : {}),
  };
}

const plural = (count: number): string => `${count} check${count === 1 ? '' : 's'}`;

export interface VerdictHeadline {
  tone: 'bad' | 'warn' | 'pending' | 'good' | 'none';
  text: string;
}

export function verdictHeadline(summary: VerdictSummary): VerdictHeadline {
  const { counts, active } = summary;
  if (active === 0) return { tone: 'none', text: 'No active checks' };
  if (counts.broke > 0)
    return { tone: 'bad', text: `${plural(counts.broke)} broke since last session` };
  if (counts.pending > 0)
    return {
      tone: 'pending',
      text: `Checking… ${active - counts.pending} of ${plural(active)} have a result`,
    };
  const failing = counts.still_failing + counts.new_failure + counts.blocked;
  if (failing > 0)
    return {
      tone: 'warn',
      text: `Nothing broke since last session · ${plural(failing)} still failing`,
    };
  return { tone: 'good', text: 'Everything that passed before passes now' };
}

export interface VerdictItem {
  target: TargetConfig;
  check: CheckConfig;
  state: LiveCheckState | undefined;
}

// OK and paused checks are counted but not listed: the report is for the change ticket.
const LISTED: readonly Verdict[] = [
  'broke',
  'still_failing',
  'new_failure',
  'blocked',
  'recovered',
  'pending',
];

/** Plain-text before/after summary for pasting into a change ticket. */
export function verdictReport(items: readonly VerdictItem[], now: string): string {
  const summary = summarizeVerdicts(items.map((item) => item.state));
  const counts = VERDICT_ORDER.filter((verdict) => summary.counts[verdict] > 0)
    .map(
      (verdict) =>
        `${summary.counts[verdict]} ${verdict === 'ok' ? 'OK' : VERDICT_LABELS[verdict].toLowerCase()}`,
    )
    .join(' · ');
  const lines = [
    `OPOSSUM post-patch check, ${now}`,
    verdictHeadline(summary).text,
    counts,
    summary.baselineFrom
      ? `Compared with each check's last result before this session (${summary.baselineFrom} to ${summary.baselineTo}).`
      : 'No results from an earlier session to compare with.',
  ];
  for (const verdict of LISTED) {
    const matching = items.filter((item) => checkVerdict(item.state) === verdict);
    if (matching.length === 0) continue;
    lines.push('', `${VERDICT_LABELS[verdict]} (${matching.length}):`);
    for (const { target, check, state } of matching) {
      const detail = verdict === 'pending' || verdict === 'recovered' ? '' : state?.result?.summary;
      lines.push(`- ${target.name} (${target.host}) / ${check.name}${detail ? `: ${detail}` : ''}`);
    }
  }
  return lines.join('\n');
}
