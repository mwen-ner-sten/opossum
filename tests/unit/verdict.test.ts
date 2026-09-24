import { describe, expect, it } from 'vitest';
import type { CheckConfig, TargetConfig } from '@core/config';
import type { CheckResult, LiveCheckState } from '@core/models';
import { checkVerdict, summarizeVerdicts, verdictHeadline, verdictReport } from '@core/verdict';

const result = (
  status: 'PASS' | 'FAIL',
  completedAt = '2026-09-23T10:00:00.000Z',
): CheckResult => ({
  status,
  category: status === 'PASS' ? 'success' : 'timeout',
  summary: status === 'PASS' ? 'Reply in 4 ms' : 'Timed out after 3 s',
  startedAt: completedAt,
  completedAt,
  durationMs: 4,
});

function state(
  before: 'PASS' | 'FAIL' | undefined,
  now: 'PASS' | 'FAIL' | 'UNKNOWN' | 'CHECKING' | 'PAUSED',
  checkId = 'ping',
): LiveCheckState {
  const lastKnown = before
    ? { lastKnown: { targetId: 'site', checkId, result: result(before) } }
    : {};
  if (now === 'PASS' || now === 'FAIL')
    return {
      targetId: 'site',
      checkId,
      status: now,
      result: result(now, '2026-09-24T12:00:00.000Z'),
      isHistorical: false,
      ...lastKnown,
    };
  return {
    targetId: 'site',
    checkId,
    status: now,
    isHistorical: before !== undefined,
    ...lastKnown,
  };
}

describe('checkVerdict', () => {
  it('compares the current result with the last result before this session', () => {
    expect(checkVerdict(state('PASS', 'FAIL'))).toBe('broke');
    expect(checkVerdict(state('FAIL', 'PASS'))).toBe('recovered');
    expect(checkVerdict(state('FAIL', 'FAIL'))).toBe('still_failing');
    expect(checkVerdict(state('PASS', 'PASS'))).toBe('ok');
  });

  it('separates failures with no earlier result from regressions', () => {
    expect(checkVerdict(state(undefined, 'FAIL'))).toBe('new_failure');
    expect(checkVerdict(state(undefined, 'PASS'))).toBe('ok');
  });

  it('treats checks without a result this session as pending', () => {
    expect(checkVerdict(state('PASS', 'UNKNOWN'))).toBe('pending');
    expect(checkVerdict(state('PASS', 'CHECKING'))).toBe('pending');
    expect(checkVerdict(undefined)).toBe('pending');
    // A last-known result is shown in the row but is not a result from this session.
    expect(
      checkVerdict({ ...state('PASS', 'UNKNOWN'), result: result('PASS'), isHistorical: true }),
    ).toBe('pending');
  });

  it('leaves paused checks out of the comparison', () => {
    expect(checkVerdict(state('PASS', 'PAUSED'))).toBe('paused');
  });

  it('keeps the previous verdict while a check re-runs, so the board does not flicker', () => {
    expect(checkVerdict({ ...state('PASS', 'FAIL'), status: 'CHECKING' })).toBe('broke');
  });

  it('separates checks that were not run because a prerequisite fails', () => {
    // One dead host must read as one breakage, not one per dependent check.
    const blocked = state('PASS', 'FAIL');
    expect(checkVerdict({ ...blocked, result: { ...blocked.result!, category: 'blocked' } })).toBe(
      'blocked',
    );
  });
});

describe('summarizeVerdicts', () => {
  it('counts every verdict and reports the baseline time span', () => {
    const early = state('PASS', 'PASS', 'a');
    early.lastKnown!.result.completedAt = '2026-09-20T08:00:00.000Z';
    const summary = summarizeVerdicts([
      early,
      state('PASS', 'FAIL', 'b'),
      state('FAIL', 'PASS', 'c'),
      state(undefined, 'UNKNOWN', 'd'),
      state('PASS', 'PAUSED', 'e'),
    ]);
    expect(summary.counts).toMatchObject({ ok: 1, broke: 1, recovered: 1, pending: 1, paused: 1 });
    expect(summary.active).toBe(4);
    expect(summary.baselineFrom).toBe('2026-09-20T08:00:00.000Z');
    expect(summary.baselineTo).toBe('2026-09-23T10:00:00.000Z');
  });
});

describe('verdictHeadline', () => {
  const headline = (states: LiveCheckState[]) => verdictHeadline(summarizeVerdicts(states));

  it('leads with regressions even while other checks are still running', () => {
    expect(headline([state('PASS', 'FAIL'), state('PASS', 'UNKNOWN', 'b')])).toEqual({
      tone: 'bad',
      text: '1 check broke since last session',
    });
  });

  it('reports progress until every active check has a result', () => {
    expect(headline([state('PASS', 'PASS'), state('PASS', 'UNKNOWN', 'b')])).toEqual({
      tone: 'pending',
      text: 'Checking… 1 of 2 checks have a result',
    });
  });

  it('counts blocked checks with the failures, not the regressions', () => {
    const blocked = state('FAIL', 'FAIL', 'b');
    expect(
      headline([
        state('FAIL', 'FAIL'),
        { ...blocked, result: { ...blocked.result!, category: 'blocked' } },
      ]),
    ).toEqual({ tone: 'warn', text: 'Nothing broke since last session · 2 checks still failing' });
  });

  it('distinguishes a clean result from pre-existing failures', () => {
    expect(headline([state('PASS', 'PASS'), state('FAIL', 'PASS', 'b')]).tone).toBe('good');
    expect(headline([state('PASS', 'PASS'), state('FAIL', 'FAIL', 'b')])).toEqual({
      tone: 'warn',
      text: 'Nothing broke since last session · 1 check still failing',
    });
    expect(headline([state('PASS', 'PAUSED')]).tone).toBe('none');
  });
});

describe('verdictReport', () => {
  const check = (id: string, name: string): CheckConfig => ({
    id,
    name,
    type: 'ping',
    enabled: true,
    tags: [],
  });
  const target: TargetConfig = {
    id: 'site',
    name: 'Denver BMS 01',
    host: '10.20.31.40',
    enabled: true,
    checks: [check('ping', 'Host ping'), check('web', 'WebStation'), check('rdp', 'RDP')],
  };

  it('lists regressions first with the current diagnostic, then the other changes', () => {
    const text = verdictReport(
      [
        { target, check: target.checks[0]!, state: state('PASS', 'PASS', 'ping') },
        { target, check: target.checks[1]!, state: state('PASS', 'FAIL', 'web') },
        { target, check: target.checks[2]!, state: state('FAIL', 'PASS', 'rdp') },
      ],
      '2026-09-24T12:30:00.000Z',
    );
    expect(text).toContain('OPOSSUM post-patch check, 2026-09-24T12:30:00.000Z');
    expect(text).toContain('1 check broke since last session');
    expect(text).toContain(
      'Broke (1):\n- Denver BMS 01 (10.20.31.40) / WebStation: Timed out after 3 s',
    );
    expect(text).toContain('Recovered (1):\n- Denver BMS 01 (10.20.31.40) / RDP');
    expect(text.indexOf('Broke')).toBeLessThan(text.indexOf('Recovered'));
    expect(text).not.toContain('Host ping');
    expect(text).toContain('1 OK');
  });
});
