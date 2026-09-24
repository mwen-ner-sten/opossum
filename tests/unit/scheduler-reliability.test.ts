import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type TargetConfig } from '@core/config';
import type { CheckRunner } from '@core/checks/base';
import type { CheckResult } from '@core/models';
import { Scheduler } from '@core/scheduler';

const target = (id: string): TargetConfig => ({
  id,
  name: id,
  host: 'localhost',
  enabled: true,
  checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
});
const result = (): CheckResult => ({
  status: 'PASS',
  category: 'success',
  summary: 'OK',
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  durationMs: 1,
});
const schedulers: Scheduler[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.stop(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});
function harness(targets = [target('a'), target('b'), target('c')], concurrency = 2) {
  const starts: string[] = [];
  const finishes: Array<() => void> = [];
  const recorded: string[] = [];
  const ping: CheckRunner = async ({ target: item }) => {
    starts.push(`${item.id}:${item.host}`);
    await new Promise<void>((resolve) => finishes.push(resolve));
    return result();
  };
  const settings = { ...DEFAULT_SETTINGS, max_concurrent_checks: concurrency };
  const scheduler = new Scheduler(
    settings,
    targets,
    [],
    {
      onStatesChanged() {},
      onPaused() {},
      onResult: (id) => {
        recorded.push(id);
      },
    },
    { runners: { ping } },
  );
  schedulers.push(scheduler);
  scheduler.start();
  return { scheduler, settings, starts, finishes, recorded, targets };
}

describe('scheduler changes while work is queued', () => {
  it('coalesces queued manual requests and never starts a check twice at once', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.scheduler.runCheck('c', 'ping');
    h.scheduler.runCheck('c', 'ping');
    expect(h.scheduler.getStates().find((s) => s.targetId === 'c')?.activity).toBe('queued');
    h.finishes[0]!();
    h.finishes[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.starts).toEqual(['a:localhost', 'b:localhost', 'c:localhost']);
  });
  it('removes deleted queued work and ignores deleted in-flight observations', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.scheduler.reload(h.settings, [h.targets[1]!]);
    h.finishes[0]!();
    h.finishes[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.starts).toEqual(['a:localhost', 'b:localhost']);
    expect(h.recorded).toEqual(['b']);
    expect(h.scheduler.getStates().map((s) => s.targetId)).toEqual(['b']);
  });
  it('uses edited configuration for queued work and discards an old in-flight result', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.scheduler.reload(
      h.settings,
      h.targets.map((t) => ({ ...t, host: '127.0.0.1' })),
    );
    h.finishes[0]!();
    h.finishes[1]!();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.recorded).toEqual([]);
    expect(h.starts.filter((s) => s === 'c:localhost')).toEqual([]);
    expect(h.starts.slice(2).every((s) => s.endsWith(':127.0.0.1'))).toBe(true);
  });
  it('does not run paused queued work, and resumes it exactly once', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.scheduler.pauseCheck('c', 'ping');
    h.finishes[0]!();
    h.finishes[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.starts).toHaveLength(2);
    h.scheduler.resumeCheck('c', 'ping');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.starts).toHaveLength(3);
  });
  it('reschedules inherited intervals immediately while preserving explicit overrides', async () => {
    const targets = [target('a'), target('b')];
    targets[1]!.checks[0]!.interval_seconds = 90;
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      targets,
      [],
      { onStatesChanged() {}, onPaused() {}, onResult() {} },
      { runners: { ping: () => Promise.resolve(result()) } },
    );
    schedulers.push(scheduler);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.reload({ ...DEFAULT_SETTINGS, default_interval_seconds: 5 }, targets);
    expect(scheduler.getStates().map((s) => Date.parse(s.nextRunAt!) - Date.now())).toEqual([
      5000, 90000,
    ]);
  });
  it('releases dependency waits when the prerequisite is paused, removed, or edited out', async () => {
    for (const mode of ['pause', 'remove', 'edit']) {
      const site = target(mode);
      site.checks.push({ ...site.checks[0]!, id: 'child', depends_on: ['ping'] });
      const h = harness([site]);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.scheduler.getStates()[1]?.activity).toBe('dependencies');
      if (mode === 'pause') {
        h.scheduler.pauseCheck(mode, 'ping');
        h.finishes[0]!();
      } else if (mode === 'remove') {
        h.scheduler.reload(h.settings, [
          { ...site, checks: [{ ...site.checks[1]!, depends_on: [] }] },
        ]);
      } else {
        h.scheduler.reload(h.settings, [
          { ...site, checks: [site.checks[0]!, { ...site.checks[1]!, depends_on: [] }] },
        ]);
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(h.starts).toHaveLength(2);
    }
  });
  it('keeps runs exclusive while asynchronous persistence is completing', async () => {
    let release: (() => void) | undefined;
    let starts = 0;
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [target('a')],
      [],
      {
        onStatesChanged() {},
        onPaused() {},
        onResult: () =>
          new Promise<void>((r) => {
            release = r;
          }),
      },
      {
        runners: {
          ping: () => {
            starts++;
            return Promise.resolve(result());
          },
        },
      },
    );
    schedulers.push(scheduler);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.runCheck('a', 'ping');
    scheduler.runCheck('a', 'ping');
    expect(starts).toBe(1);
    release!();
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toBe(2);
  });
});
