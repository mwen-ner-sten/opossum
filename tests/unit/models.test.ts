import { describe, expect, it } from 'vitest';
import { aggregateStatus } from '@core/models';
import { DEFAULT_SETTINGS, type TargetConfig } from '@core/config';
import { Scheduler } from '@core/scheduler';
import type { CheckRunner } from '@core/checks/base';

describe('target status aggregation', () => {
  it('uses the worst enabled-check state and ignores paused checks', () => {
    expect(aggregateStatus(['PASS', 'FAIL', 'CHECKING'])).toBe('FAIL');
    expect(aggregateStatus(['PASS', 'CHECKING'])).toBe('CHECKING');
    expect(aggregateStatus(['PASS', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(aggregateStatus(['PASS', 'PAUSED'])).toBe('PASS');
    expect(aggregateStatus(['PAUSED'])).toBe('PAUSED');
    expect(aggregateStatus([])).toBe('PAUSED');
  });
});

describe('scheduler reload', () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const ok: CheckRunner = () => {
    const stamp = new Date().toISOString();
    return Promise.resolve({
      status: 'PASS',
      category: 'success',
      summary: 'OK',
      startedAt: stamp,
      completedAt: stamp,
      durationMs: 1,
    });
  };
  const target = (id: string, enabled = true, interval = 3600): TargetConfig => ({
    id,
    name: id,
    host: 'localhost',
    enabled,
    checks: [
      {
        id: 'ping',
        name: 'Ping',
        type: 'ping',
        enabled: true,
        tags: [],
        interval_seconds: interval,
      },
    ],
  });

  it('adds, removes, pauses, and reschedules entries without losing state', async () => {
    let paused = 0;
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [target('one')],
      [
        {
          targetId: 'one',
          checkId: 'ping',
          result: {
            status: 'FAIL',
            category: 'timeout',
            summary: 'old',
            startedAt: 'x',
            completedAt: 'x',
            durationMs: 0,
          },
        },
      ],
      {
        onStatesChanged: () => undefined,
        onResult: () => undefined,
        onPaused: () => {
          paused += 1;
        },
      },
      { runners: { ping: ok } },
    );
    expect(scheduler.getStates()[0]).toMatchObject({ isHistorical: true, status: 'UNKNOWN' });
    scheduler.start();
    await tick();
    expect(scheduler.getStates()[0]?.status).toBe('PASS');

    scheduler.reload(DEFAULT_SETTINGS, [target('one'), target('two')]);
    await tick();
    expect(
      scheduler
        .getStates()
        .map((state) => state.targetId)
        .sort(),
    ).toEqual(['one', 'two']);

    scheduler.reload(DEFAULT_SETTINGS, [target('one', false), target('two')]);
    expect(scheduler.getStates().find((s) => s.targetId === 'one')?.status).toBe('PAUSED');
    expect(paused).toBe(1);

    scheduler.reload(DEFAULT_SETTINGS, [target('one'), target('two', true, 10)]);
    await tick();
    expect(scheduler.getStates().find((s) => s.targetId === 'one')?.status).toBe('PASS');
    expect(scheduler.getStates().find((s) => s.targetId === 'two')?.nextRunAt).toBeDefined();

    scheduler.reload(DEFAULT_SETTINGS, [target('two')]);
    expect(scheduler.getStates().map((state) => state.targetId)).toEqual(['two']);
    scheduler.runTarget('two');
    scheduler.runAll();
    await tick();
    await scheduler.stop();
  });
});
