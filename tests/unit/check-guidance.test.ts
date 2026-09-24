import { expect, it } from 'vitest';
import { checkGuidance } from '@core/check-guidance';
import type { TargetConfig } from '@core/config';
import type { LiveCheckState } from '@core/models';
const target: TargetConfig = {
  id: 'site',
  name: 'Site',
  host: 'localhost',
  enabled: true,
  checks: [
    { id: 'ping', name: 'Host ping', type: 'ping', enabled: true, tags: [] },
    { id: 'child', name: 'Child', type: 'ping', enabled: true, tags: [], depends_on: ['ping'] },
  ],
};
const state: LiveCheckState = {
  targetId: 'site',
  checkId: 'child',
  status: 'UNKNOWN',
  isHistorical: false,
};
it('provides distinct actions for capacity, dependencies, pauses, and backoff', () => {
  const explain = (extra: Partial<LiveCheckState>, paused = false) =>
    checkGuidance(target, target.checks[1]!, { ...state, ...extra }, paused);
  expect(explain({ activity: 'queued' }).action).toBe('settings');
  expect(explain({ activity: 'dependencies', dependencyId: 'ping' }).label).toBe(
    'Inspect Host ping',
  );
  expect(explain({ status: 'PAUSED' }).action).toBe('resume');
  expect(explain({ status: 'PAUSED' }, true).action).toBe('resumeAll');
  expect(explain({ status: 'FAIL', backoffMs: 120000 }).explanation).toContain('120 seconds');
  expect(explain({ activity: 'retry' }).title).toBe('Confirming a failure');
  expect(checkGuidance({ ...target, enabled: false }, target.checks[0]!, state).action).toBe(
    'edit',
  );
});
