import { afterEach, describe, expect, it } from 'vitest';
import { CHECK_RUNNERS } from '@core/checks';
import { DEFAULT_SETTINGS, type TargetConfig } from '@core/config';
import { Scheduler } from '@core/scheduler';

const originalPing = CHECK_RUNNERS.ping;
afterEach(() => {
  CHECK_RUNNERS.ping = originalPing;
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('scheduler', () => {
  it('enforces concurrency and coalesces repeated manual reruns', async () => {
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const starts: string[] = [];
    CHECK_RUNNERS.ping = async (context) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      starts.push(context.target.id);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      const stamp = new Date().toISOString();
      return {
        status: 'PASS',
        category: 'success',
        summary: 'OK',
        startedAt: stamp,
        completedAt: stamp,
        durationMs: 1,
      };
    };
    const target = (id: string): TargetConfig => ({
      id,
      name: id,
      host: 'localhost',
      enabled: true,
      checks: [
        { id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [], interval_seconds: 3600 },
      ],
    });
    const scheduler = new Scheduler(
      { ...DEFAULT_SETTINGS, max_concurrent_checks: 1 },
      [target('one'), target('two')],
      [],
      { onStatesChanged: () => undefined, onResult: () => undefined, onPaused: () => undefined },
    );
    scheduler.start();
    await tick();
    expect(maximumActive).toBe(1);
    expect(starts).toEqual(['one']);
    scheduler.runCheck('one', 'ping');
    scheduler.runCheck('one', 'ping');
    resolvers.shift()?.();
    await tick();
    expect(starts).toEqual(['one', 'two']);
    resolvers.shift()?.();
    await tick();
    expect(starts).toEqual(['one', 'two', 'one']);
    resolvers.shift()?.();
    await tick();
    expect(starts.filter((id) => id === 'one')).toHaveLength(2);
    await scheduler.stop();
  });

  it('turns unexpected runner exceptions into a completed failure state', async () => {
    CHECK_RUNNERS.ping = () => Promise.reject(new Error('boom'));
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [
        {
          id: 'one',
          name: 'One',
          host: 'localhost',
          enabled: true,
          checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
        },
      ],
      [],
      { onStatesChanged: () => undefined, onResult: () => undefined, onPaused: () => undefined },
    );
    scheduler.start();
    await tick();
    await tick();
    expect(scheduler.getStates()[0]).toMatchObject({
      status: 'FAIL',
      result: { category: 'unexpected' },
    });
    await scheduler.stop();
  });
});
