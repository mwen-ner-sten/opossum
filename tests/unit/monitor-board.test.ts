import { describe, expect, it } from 'vitest';
import type { CheckConfig } from '@core/config';
import type { CheckResult, LiveCheckState } from '@core/models';
import {
  byHealth,
  countLevels,
  foldHealthy,
  targetHealth,
  targetIssue,
} from '../../src/renderer/src/features/monitor/board';

const result = (status: 'PASS' | 'FAIL', category: CheckResult['category'], summary: string) => ({
  status,
  category,
  summary,
  startedAt: '2026-09-24T12:00:00.000Z',
  completedAt: '2026-09-24T12:00:00.000Z',
  durationMs: 5,
});
const pass = (before: 'PASS' | 'FAIL' = 'PASS'): LiveCheckState => ({
  targetId: 't',
  checkId: 'c',
  status: 'PASS',
  result: result('PASS', 'success', 'OK'),
  lastKnown: { targetId: 't', checkId: 'c', result: result(before, 'success', 'earlier') },
  isHistorical: false,
});
const fail = (
  before: 'PASS' | 'FAIL' = 'PASS',
  category: CheckResult['category'] = 'http_status',
  summary = 'HTTP 503; expected 200',
): LiveCheckState => ({
  ...pass(before),
  status: 'FAIL',
  result: result('FAIL', category, summary),
});
const pending: LiveCheckState = {
  targetId: 't',
  checkId: 'c',
  status: 'UNKNOWN',
  isHistorical: false,
};
const paused: LiveCheckState = { ...pending, status: 'PAUSED' };
const check = (id: string, name: string): CheckConfig => ({
  id,
  name,
  type: 'http',
  enabled: true,
  tags: [],
  url: 'http://x',
  method: 'GET',
  expected_status: 200,
  headers: {},
  follow_redirects: true,
  verify_tls: true,
});

describe('targetHealth', () => {
  it('ranks regressions above other failures, then unfinished, then healthy', () => {
    expect(targetHealth([pass(), fail('PASS')]).level).toBe('broke');
    expect(targetHealth([pass(), fail('FAIL')]).level).toBe('failing');
    expect(targetHealth([pass(), pending]).level).toBe('pending');
    expect(targetHealth([pass(), paused]).level).toBe('ok');
    expect(targetHealth([paused]).level).toBe('paused');
    expect(targetHealth([]).level).toBe('paused');
  });

  it('flags a target whose checks recovered', () => {
    expect(targetHealth([pass('FAIL'), pass()])).toMatchObject({ level: 'ok', recovered: 1 });
  });
});

describe('targetIssue', () => {
  const checks = [check('host', 'Host'), check('web', 'WebStation'), check('api', 'API')];

  it('names the root failure rather than the checks it blocked', () => {
    const issue = targetIssue(checks, [
      fail('PASS', 'connection_refused', 'Connection refused'),
      fail('PASS', 'blocked', 'Blocked by Host'),
      fail('PASS', 'blocked', 'Blocked by Host'),
    ]);
    expect(issue).toEqual({
      checkId: 'host',
      checkName: 'Host',
      summary: 'Connection refused',
      others: 2,
    });
  });

  it('prefers a regression over a check that was already failing', () => {
    const issue = targetIssue(checks, [pass(), fail('FAIL', 'timeout', 'Timed out'), fail('PASS')]);
    expect(issue?.checkName).toBe('API');
    expect(issue?.others).toBe(1);
  });

  it('returns nothing when no check is failing', () => {
    expect(targetIssue(checks, [pass(), pass(), pending])).toBeUndefined();
  });
});

describe('byHealth', () => {
  it('sorts worst first and keeps configured order within a level', () => {
    const items = [
      { id: 'a', level: 'ok' as const },
      { id: 'b', level: 'failing' as const },
      { id: 'c', level: 'broke' as const },
      { id: 'd', level: 'ok' as const },
      { id: 'e', level: 'pending' as const },
    ];
    expect(byHealth(items, (item) => item.level).map((item) => item.id)).toEqual([
      'c',
      'b',
      'e',
      'a',
      'd',
    ]);
  });
});

describe('countLevels', () => {
  it('summarizes a group by target health, worst first', () => {
    expect(countLevels(['ok', 'broke', 'ok', 'failing']).text).toBe('1 broke · 1 failing · 2 OK');
    expect(countLevels(['ok', 'ok']).text).toBe('All OK');
    expect(countLevels(['pending', 'ok', 'paused']).text).toBe('1 checking · 1 OK · 1 paused');
  });
});

describe('foldHealthy', () => {
  const rows = [
    { id: 'a', level: 'broke' as const },
    { id: 'b', level: 'ok' as const },
    { id: 'c', level: 'ok' as const },
    { id: 'd', level: 'paused' as const },
  ];
  const levelOf = (row: (typeof rows)[number]) => row.level;
  const idOf = (row: (typeof rows)[number]) => row.id;

  it('folds healthy rows away but keeps paused and failing rows listed', () => {
    const { shown, folded } = foldHealthy(rows, levelOf, idOf, new Set());
    expect(shown.map(idOf)).toEqual(['a', 'd']);
    expect(folded.map(idOf)).toEqual(['b', 'c']);
  });

  it('never folds a row the operator is looking at, even after it recovers', () => {
    const { shown, folded } = foldHealthy(rows, levelOf, idOf, new Set(['c']));
    expect(shown.map(idOf)).toEqual(['a', 'c', 'd']);
    expect(folded.map(idOf)).toEqual(['b']);
  });
});
