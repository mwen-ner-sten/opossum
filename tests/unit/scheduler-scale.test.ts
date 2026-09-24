import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type TargetConfig } from '@core/config';
import type { CheckRunner } from '@core/checks/base';
import { Scheduler } from '@core/scheduler';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([100, 500])(
  'recovers %i sites with three checks, bounded concurrency and batched updates',
  async (count) => {
    vi.useFakeTimers();
    const targets: TargetConfig[] = Array.from({ length: count }, (_, index) => ({
      id: `site-${index}`,
      name: `Site ${index}`,
      host: 'localhost',
      enabled: true,
      checks: ['ping', 'port', 'web'].map((id, i) => ({
        id,
        name: id,
        type: 'ping',
        enabled: true,
        tags: [],
        ...(i ? { depends_on: ['ping'] } : {}),
      })),
    }));
    let outage = true;
    let active = 0;
    let maximum = 0;
    let observations = 0;
    let snapshots = 0;
    const inFlight = new Set<string>();
    const runner: CheckRunner = async ({ target, check }) => {
      const key = `${target.id}/${check.id}`;
      expect(inFlight.has(key)).toBe(false);
      inFlight.add(key);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active--;
      inFlight.delete(key);
      return {
        status: outage ? 'FAIL' : 'PASS',
        category: outage ? 'timeout' : 'success',
        summary: outage ? 'Timed out' : 'OK',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
      };
    };
    const scheduler = new Scheduler(
      { ...DEFAULT_SETTINGS, max_concurrent_checks: 20 },
      targets,
      [],
      {
        onStatesChanged: () => {
          snapshots++;
        },
        onResult: () => {
          observations++;
        },
        onPaused() {},
      },
      { runners: { ping: runner }, publishIntervalMs: 100 },
    );
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(200);
      expect(scheduler.getStates().filter((s) => s.result?.category === 'blocked')).toHaveLength(
        count * 2,
      );
      expect(observations).toBe(count * 3);
      outage = false;
      scheduler.runAll();
      await vi.advanceTimersByTimeAsync(200);
      expect(scheduler.getStates().every((s) => s.status === 'PASS')).toBe(true);
      expect(maximum).toBeLessThanOrEqual(20);
      expect(active).toBe(0);
      expect(snapshots).toBeLessThanOrEqual(4);
      console.info(
        `Scale: ${count} sites / ${count * 3} checks; ${observations} observations; ${snapshots} screen snapshots; peak ${maximum} concurrent.`,
      );
    } finally {
      await scheduler.stop(0);
    }
  },
);
