import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  targetSchema,
  validateDependencies,
  type TargetConfig,
} from '@core/config';
import type { CheckRunner } from '@core/checks/base';
import type { CheckResult, LiveCheckState } from '@core/models';
import { Scheduler, type SchedulerCallbacks } from '@core/scheduler';

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();
const result = (status: 'PASS' | 'FAIL'): CheckResult => ({
  status,
  category: status === 'PASS' ? 'success' : 'timeout',
  summary: status === 'PASS' ? 'OK' : 'Timed out',
  startedAt: stamp(),
  completedAt: stamp(),
  durationMs: 1,
});

/** ping ← rdp ← web, plus ssh which depends on ping only. */
const chain = (): TargetConfig => ({
  id: 'site',
  name: 'Site',
  host: 'localhost',
  enabled: true,
  checks: [
    { id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [], interval_seconds: 3600 },
    {
      id: 'rdp',
      name: 'RDP',
      type: 'tcp',
      port: 3389,
      enabled: true,
      tags: [],
      interval_seconds: 3600,
      depends_on: ['ping'],
    },
    {
      id: 'web',
      name: 'Web',
      type: 'http',
      url: 'https://localhost/',
      method: 'GET',
      expected_status: '200-399',
      headers: {},
      verify_tls: true,
      follow_redirects: true,
      enabled: true,
      tags: [],
      interval_seconds: 3600,
      depends_on: ['rdp'],
    },
    {
      id: 'ssh',
      name: 'SSH',
      type: 'tcp',
      port: 22,
      enabled: true,
      tags: [],
      interval_seconds: 3600,
      depends_on: ['ping'],
    },
  ],
});

function harness(pingStatus: 'PASS' | 'FAIL') {
  const runs: string[] = [];
  const recorded: Array<{ checkId: string; result: CheckResult }> = [];
  let states: LiveCheckState[] = [];
  const runner =
    (status: 'PASS' | 'FAIL'): CheckRunner =>
    async (context) => {
      runs.push(context.check.id);
      await tick(5);
      return result(status);
    };
  const callbacks: SchedulerCallbacks = {
    onStatesChanged: (next) => {
      states = next;
    },
    onResult: (_target, checkId, value) => {
      recorded.push({ checkId, result: value });
    },
    onPaused: () => undefined,
  };
  const scheduler = new Scheduler(DEFAULT_SETTINGS, [chain()], [], callbacks, {
    runners: { ping: runner(pingStatus), tcp: runner('FAIL'), http: runner('PASS') },
  });
  const stateOf = (id: string) => states.find((state) => state.checkId === id);
  return { scheduler, runs, recorded, stateOf };
}

describe('check dependencies', () => {
  it('only lets a step wait on earlier steps, which rules out cycles', () => {
    expect(validateDependencies([{ id: 'a', depends_on: ['b'] }])[0]?.message).toMatch(/unknown/);
    expect(validateDependencies([{ id: 'a', depends_on: ['a'] }])[0]?.message).toMatch(/itself/);
    const forward = validateDependencies([
      { id: 'a', depends_on: ['b'] },
      { id: 'b', depends_on: ['c'] },
      { id: 'c', depends_on: ['a'] },
    ]);
    expect(forward.map((issue) => issue.checkId)).toEqual(['a', 'b']);
    expect(forward[0]?.message).toMatch(/Step 1 can only wait on earlier steps; "b" is step 2/);
    expect(
      validateDependencies([{ id: 'ping' }, { id: 'rdp', depends_on: ['ping'] }]),
    ).toEqual([]);
    const target = chain();
    target.checks[1]!.depends_on = ['web'];
    expect(targetSchema.safeParse(target).success).toBe(false);
    expect(targetSchema.safeParse(chain()).success).toBe(true);
  });

  it('waits for precursors on first run and blocks dependents when a precursor fails', async () => {
    const { scheduler, runs, recorded, stateOf } = harness('FAIL');
    scheduler.start();
    await tick(40);
    // Only ping touched the network; everything downstream is blocked without running.
    expect(runs).toEqual(['ping']);
    expect(stateOf('rdp')?.result?.category).toBe('blocked');
    expect(stateOf('web')?.result?.category).toBe('blocked');
    expect(stateOf('ssh')?.result?.category).toBe('blocked');
    expect(stateOf('rdp')?.result?.summary).toMatch(/Blocked: Ping is failing/);
    expect(recorded.filter((item) => item.result.category === 'blocked')).toHaveLength(3);
    await scheduler.stop();
  });

  it('runs dependents once their precursor passes, and stops at the first failing hop', async () => {
    const { scheduler, runs, stateOf } = harness('PASS');
    scheduler.start();
    await tick(60);
    expect(runs.slice(0, 3).sort()).toEqual(['ping', 'rdp', 'ssh']);
    expect(runs).not.toContain('web'); // rdp (tcp runner) fails, so web is blocked
    expect(stateOf('rdp')?.status).toBe('FAIL');
    expect(stateOf('web')?.result?.category).toBe('blocked');
    await scheduler.stop();
  });

  it('re-runs a blocked check immediately when its precursor recovers', async () => {
    let pingStatus: 'PASS' | 'FAIL' = 'FAIL';
    const runs: string[] = [];
    const ping: CheckRunner = async (context) => {
      runs.push(context.check.id);
      await tick(5);
      return result(pingStatus);
    };
    const target = chain();
    target.checks = target.checks.filter((check) => ['ping', 'ssh'].includes(check.id));
    const scheduler = new Scheduler(
      DEFAULT_SETTINGS,
      [target],
      [],
      { onStatesChanged: () => undefined, onResult: () => undefined, onPaused: () => undefined },
      { runners: { ping, tcp: ping } },
    );
    scheduler.start();
    await tick(40);
    expect(runs).toEqual(['ping']);
    pingStatus = 'PASS';
    scheduler.runCheck('site', 'ping');
    await tick(60);
    expect(runs).toEqual(['ping', 'ping', 'ssh']);
    await scheduler.stop();
  });
});

describe('failure backoff', () => {
  it('doubles the interval after the failure threshold and resets on recovery', async () => {
    let status: 'PASS' | 'FAIL' = 'FAIL';
    const ping: CheckRunner = async () => {
      await tick(1);
      return result(status);
    };
    const target = chain();
    target.checks = [{ ...target.checks[0]!, interval_seconds: 10 }];
    let states: LiveCheckState[] = [];
    const scheduler = new Scheduler(
      { ...DEFAULT_SETTINGS, failure_backoff_max_seconds: 60 },
      [target],
      [],
      {
        onStatesChanged: (next) => {
          states = next;
        },
        onResult: () => undefined,
        onPaused: () => undefined,
      },
      { runners: { ping } },
    );
    scheduler.start();
    await tick(30);
    const first = states[0]!;
    expect(first.status).toBe('FAIL');
    expect(first.backoffMs).toBeUndefined(); // first failure keeps the normal interval
    scheduler.runCheck('site', 'ping');
    await tick(30);
    expect(states[0]?.backoffMs).toBe(20_000);
    scheduler.runCheck('site', 'ping');
    await tick(30);
    expect(states[0]?.backoffMs).toBe(40_000);
    scheduler.runCheck('site', 'ping');
    await tick(30);
    expect(states[0]?.backoffMs).toBe(60_000); // capped
    status = 'PASS';
    scheduler.runCheck('site', 'ping');
    await tick(30);
    expect(states[0]?.status).toBe('PASS');
    expect(states[0]?.backoffMs).toBeUndefined();
    await scheduler.stop();
  });

  it('is disabled when the cap is zero', async () => {
    const ping: CheckRunner = async () => {
      await tick(1);
      return result('FAIL');
    };
    let states: LiveCheckState[] = [];
    const scheduler = new Scheduler(
      { ...DEFAULT_SETTINGS, failure_backoff_max_seconds: 0 },
      [chain()],
      [],
      {
        onStatesChanged: (next) => {
          states = next;
        },
        onResult: () => undefined,
        onPaused: () => undefined,
      },
      { runners: { ping } },
    );
    scheduler.start();
    await tick(30);
    scheduler.runCheck('site', 'ping');
    await tick(30);
    scheduler.runCheck('site', 'ping');
    await tick(30);
    expect(states.find((state) => state.checkId === 'ping')?.backoffMs).toBeUndefined();
    await scheduler.stop();
  });
});
