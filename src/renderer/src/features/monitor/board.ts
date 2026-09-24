import type { CheckConfig } from '@core/config';
import type { LiveCheckState } from '@core/models';
import { checkVerdict } from '@core/verdict';

/** Worst-first health of a target or group, used to put problems at the top of the board. */
export type HealthLevel = 'broke' | 'failing' | 'pending' | 'ok' | 'paused';

const RANK: Record<HealthLevel, number> = { broke: 0, failing: 1, pending: 2, ok: 3, paused: 4 };

export const HEALTH_ORDER: readonly HealthLevel[] = ['broke', 'failing', 'pending', 'ok', 'paused'];

const HEALTH_WORDS: Record<HealthLevel, string> = {
  broke: 'broke',
  failing: 'failing',
  pending: 'checking',
  ok: 'OK',
  paused: 'paused',
};

/** Target counts per health level plus a short summary such as "1 broke · 4 OK". */
export function countLevels(levels: Iterable<HealthLevel>): {
  counts: Record<HealthLevel, number>;
  text: string;
} {
  const counts: Record<HealthLevel, number> = {
    broke: 0,
    failing: 0,
    pending: 0,
    ok: 0,
    paused: 0,
  };
  for (const level of levels) counts[level] += 1;
  const present = HEALTH_ORDER.filter((level) => counts[level] > 0);
  const text =
    present.length === 1 && present[0] === 'ok'
      ? 'All OK'
      : present.map((level) => `${counts[level]} ${HEALTH_WORDS[level]}`).join(' · ');
  return { counts, text };
}

export interface TargetHealth {
  level: HealthLevel;
  broke: number;
  recovered: number;
}

export function targetHealth(states: readonly LiveCheckState[]): TargetHealth {
  let broke = 0;
  let recovered = 0;
  let failing = false;
  let pending = false;
  let active = false;
  for (const state of states) {
    const verdict = checkVerdict(state);
    if (verdict === 'paused') continue;
    active = true;
    if (verdict === 'broke') broke += 1;
    else if (verdict === 'recovered') recovered += 1;
    else if (verdict === 'pending') pending = true;
    // Checks that are re-running keep their last status, so FAIL still reads as failing.
    if (state.status === 'FAIL') failing = true;
  }
  const level: HealthLevel = !active
    ? 'paused'
    : broke > 0
      ? 'broke'
      : failing
        ? 'failing'
        : pending
          ? 'pending'
          : 'ok';
  return { level, broke, recovered };
}

/** The worst of several levels, for a group heading. */
export function worstLevel(levels: Iterable<HealthLevel>): HealthLevel {
  let worst: HealthLevel = 'paused';
  for (const level of levels) if (RANK[level] < RANK[worst]) worst = level;
  return worst;
}

/** Stable worst-first order; items at the same level keep their configured order. */
export function byHealth<T>(items: readonly T[], levelOf: (item: T) => HealthLevel): T[] {
  return items
    .map((item, index) => ({ item, index, rank: RANK[levelOf(item)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Splits rows into those listed and the healthy ones folded into a single line. A row that is
 * pinned (expanded, or holding the selected check) stays listed so it cannot vanish when it
 * recovers mid-session.
 */
export function foldHealthy<T>(
  rows: readonly T[],
  levelOf: (row: T) => HealthLevel,
  idOf: (row: T) => string,
  pinned: ReadonlySet<string>,
): { shown: T[]; folded: T[] } {
  const shown: T[] = [];
  const folded: T[] = [];
  for (const row of rows)
    if (levelOf(row) !== 'ok' || pinned.has(idOf(row))) shown.push(row);
    else folded.push(row);
  return { shown, folded };
}

export interface TargetIssue {
  checkId: string;
  checkName: string;
  summary: string;
  /** Other failing checks on the same target, blocked ones included. */
  others: number;
}

/**
 * The one failure worth reading on a collapsed target row. A check that was actually probed
 * beats one it blocked, and a regression beats a check that was already failing.
 */
export function targetIssue(
  checks: readonly CheckConfig[],
  states: readonly LiveCheckState[],
): TargetIssue | undefined {
  const failing = checks
    .map((check, index) => ({ check, state: states[index] }))
    .filter(({ state }) => state?.status === 'FAIL');
  if (failing.length === 0) return undefined;
  const score = ({ state }: (typeof failing)[number]): number =>
    (state?.result?.category === 'blocked' ? 2 : 0) + (checkVerdict(state) === 'broke' ? 0 : 1);
  const root = failing.reduce((best, item) => (score(item) < score(best) ? item : best));
  return {
    checkId: root.check.id,
    checkName: root.check.name,
    summary: root.state?.result?.summary ?? 'Failing',
    others: failing.length - 1,
  };
}
