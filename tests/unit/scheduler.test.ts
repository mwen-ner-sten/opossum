import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type TargetConfig } from '@core/config';
import type { CheckRunner } from '@core/checks/base';
import type { CheckResult } from '@core/models';
import { Scheduler, type SchedulerCallbacks } from '@core/scheduler';

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();
const pass = (): CheckResult => ({
  status: 'PASS',
  category: 'success',
  summary: 'OK',
  startedAt: stamp(),
  completedAt: stamp(),
  durationMs: 1,
});
const fail = (): CheckResult => ({
  status: 'FAIL',
  category: 'timeout',
  summary: 'Timed out',
  startedAt: stamp(),
  completedAt: stamp(),
  durationMs: 1,
});
const target = (id: string, extra: Partial<TargetConfig['checks'][number]> = {}): TargetConfig => ({
  id,
  name: id,
  host: 'localhost',
  enabled: true,
  checks: [
    {
      id: 'ping',
      name: 'Ping',
      type: 'ping',
      enabled: true,
      tags: [],
      interval_seconds: 3600,
      ...extra,
    } as TargetConfig['checks'][number],
  ],
});
const silent: SchedulerCallbacks = {
  onStatesChanged: () => undefined,
  onResult: () => undefined,
  onPaused: () => undefined,
};

describe('scheduler', () => {
  it('enforces concurrency and coalesces repeated manual reruns', async () => {
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const starts: string[] = [];
    const ping: CheckRunner = async (context) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      starts.push(context.target.id);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      return pass();
    };
    const scheduler = new Scheduler(
      { ...DEFAULT_SETTINGS, max_concurrent_checks: 1 },
      [target('one'), target('two')],
      [],
      silent,
      { runners: { ping } },
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
    const scheduler = new Scheduler(DEFAULT_SETTINGS, [target('one')], [], silent, {
      runners: { ping: () => Promise.reject(new Error('boom')) },
    });
    scheduler.start();
    await tick();
    await tick();
    expect(scheduler.getStates()[0]).toMatchObject({
      status: 'FAIL',
      result: { category: 'unexpected' },
    });
    await scheduler.stop();
  });

  it('finishes an active run before entering a paused interval', async () => {
    let finish: (() => void) | undefined;
    let pausedRecords = 0;
    const ping: CheckRunner = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return pass();
    };
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [target('one')],
      [],
      {
        ...silent,
        onPaused: () => {
          pausedRecords += 1;
        },
      },
      { runners: { ping } },
    );
    scheduler.start();
    await tick();
    scheduler.pauseCheck('one', 'ping');
    expect(scheduler.getStates()[0]?.status).toBe('CHECKING');
    finish?.();
    await tick();
    expect(scheduler.getStates()[0]?.status).toBe('PAUSED');
    expect(pausedRecords).toBe(1);
    await scheduler.stop();
  });

  it('never persists a canceled result when stopping mid-check', async () => {
    const recorded: CheckResult[] = [];
    const ping: CheckRunner = (context) =>
      new Promise((resolve) => {
        context.signal.addEventListener('abort', () =>
          resolve({ ...fail(), category: 'canceled', summary: 'Ping canceled' }),
        );
      });
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [target('one')],
      [],
      { ...silent, onResult: (_t, _c, result) => void recorded.push(result) },
      { runners: { ping } },
    );
    scheduler.start();
    await tick(5);
    await scheduler.stop();
    await tick(5);
    expect(recorded).toEqual([]);
    expect(scheduler.getStates()[0]?.status).toBe('UNKNOWN');
  });

  it('keeps individually paused checks paused across pause all / resume all', async () => {
    const scheduler = new Scheduler(DEFAULT_SETTINGS, [target('one'), target('two')], [], silent, {
      runners: { ping: () => Promise.resolve(pass()) },
    });
    scheduler.start();
    await tick();
    scheduler.pauseCheck('one', 'ping');
    scheduler.pauseAllChecks();
    expect(scheduler.getStates().map((state) => state.status)).toEqual(['PAUSED', 'PAUSED']);
    scheduler.resumeAllChecks();
    await tick();
    const byId = new Map(scheduler.getStates().map((state) => [state.targetId, state.status]));
    expect(byId.get('one')).toBe('PAUSED');
    expect(byId.get('two')).not.toBe('PAUSED');
    await scheduler.stop();
  });

  it('retries quietly until failures_before_fail is reached', async () => {
    const recorded: CheckResult[] = [];
    const results = [fail(), fail(), fail()];
    const ping: CheckRunner = () => Promise.resolve(results.shift() ?? pass());
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [target('one', { failures_before_fail: 3 })],
      [],
      { ...silent, onResult: (_t, _c, result) => void recorded.push(result) },
      { runners: { ping }, softFailRetryMs: 1 },
    );
    scheduler.start();
    await tick(5);
    expect(scheduler.getStates()[0]?.status).toBe('UNKNOWN');
    await tick(20);
    expect(scheduler.getStates()[0]?.status).toBe('FAIL');
    expect(recorded).toHaveLength(1);
    await scheduler.stop();
  });

  it('reports persistence failures through onError instead of swallowing them', async () => {
    const errors: string[] = [];
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [target('one')],
      [],
      {
        ...silent,
        onResult: () => Promise.reject(new Error('disk full')),
        onError: (context) => void errors.push(context),
      },
      { runners: { ping: () => Promise.resolve(pass()) } },
    );
    scheduler.start();
    await tick();
    await tick();
    expect(errors[0]).toContain('record result one/ping');
    expect(scheduler.getStates()[0]?.status).toBe('PASS');
    await scheduler.stop();
  });
});
