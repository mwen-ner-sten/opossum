import { describe, expect, it } from 'vitest';
import { sessionCsv, sessionText, type ReportInterval } from '@core/reports';
import type { SessionSummary } from '@core/models';

const session: SessionSummary = {
  id: 'session',
  startedAt: '2026-09-04T10:00:00.000Z',
  endedAt: '2026-09-04T10:01:00.000Z',
  lastHeartbeatAt: '2026-09-04T10:01:00.000Z',
  applicationVersion: '0.1',
  cleanShutdown: true,
  passCount: 0,
  failCount: 1,
};
const row: ReportInterval = {
  targetId: 'site',
  targetName: '=HYPERLINK("bad")',
  host: 'localhost',
  checkId: 'ping',
  checkName: 'Ping',
  status: 'FAIL',
  category: 'timeout',
  startAt: session.startedAt,
  endAt: session.endedAt!,
  observations: 2,
  summary: 'Timed out, "again"\nnext line',
};
describe('session reports', () => {
  it('quotes CSV, neutralizes spreadsheet formulas, and labels blocked checks separately', () => {
    const csv = sessionCsv(session, [
      row,
      { ...row, category: 'blocked', targetName: '\t+formula' },
    ]);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"\'\t+formula"');
    expect(csv).toContain('"Timed out, ""again""\nnext line"');
    expect(csv).toContain('"BLOCKED"');
    expect(csv).toContain('"60","2"');
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });
  it('distinguishes outages, blocked intervals, and unobserved periods without claiming SLA uptime', () => {
    const report = sessionText(session, [row, { ...row, category: 'blocked' }], session.endedAt!);
    expect(report).toContain('1 failure intervals; 1 blocked intervals');
    expect(report).toContain('Blocked checks (not probed)');
    expect(report).toContain('Unknown and paused periods');
    expect(report).toContain(session.startedAt);
  });
  it('handles empty and ongoing sessions explicitly', () => {
    expect(sessionCsv(session, []).split('\r\n')).toHaveLength(2);
    const ongoing = { ...session };
    delete ongoing.endedAt;
    expect(sessionText(ongoing, [], session.lastHeartbeatAt)).toContain('(in progress)');
    expect(sessionText(session, [], session.endedAt!)).toContain(
      'No failures in retained observations',
    );
  });
});
