import {
  effectiveFailureThreshold,
  effectiveInterval,
  type AppSettings,
  type CheckConfig,
  type TargetConfig,
} from './config';
import { CHECK_RUNNERS } from './checks';
import type { CheckRunner } from './checks/base';
import type { CheckResult, LastKnownState, LiveCheckState } from './models';

export interface SchedulerCallbacks {
  onStatesChanged(states: LiveCheckState[]): void;
  onResult(targetId: string, checkId: string, result: CheckResult): Promise<void> | void;
  onPaused(targetId: string, checkId: string): Promise<void> | void;
  /** Invoked when a persistence callback throws; the scheduler itself keeps running. */
  onError?(context: string, error: unknown): void;
}

export interface SchedulerOptions {
  runners?: Partial<Record<CheckConfig['type'], CheckRunner>>;
  /** Delay before re-running a check whose failure count is still below its threshold. */
  softFailRetryMs?: number;
}

interface Entry {
  target: TargetConfig;
  check: CheckConfig;
  state: LiveCheckState;
  timer?: ReturnType<typeof setTimeout> | undefined;
  controller?: AbortController | undefined;
  running: boolean;
  manualQueued: boolean;
  pausedByUser: boolean;
  consecutiveFailures: number;
  lastStartedAt?: number | undefined;
  /** Set while a run is deferred until every precursor has produced a result this session. */
  waitingOnDependencies: boolean;
}

const keyFor = (targetId: string, checkId: string): string => `${targetId}\0${checkId}`;
const DEFAULT_SOFT_FAIL_RETRY_MS = 2_000;

/** Keeps the moment a PASS/FAIL status began; a result with a different status restarts it. */
function statusSince(previous: LiveCheckState, result: CheckResult): string {
  const held = !previous.isHistorical && previous.result?.status === result.status;
  return held ? (previous.statusSince ?? result.completedAt) : result.completedAt;
}

export class Scheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly waiting: Array<() => Promise<void>> = [];
  private readonly runners: Record<CheckConfig['type'], CheckRunner>;
  private readonly softFailRetryMs: number;
  private activeCount = 0;
  private stopped = false;
  private started = false;
  private pausedAll = false;

  constructor(
    private settings: AppSettings,
    targets: TargetConfig[],
    lastKnown: LastKnownState[],
    private readonly callbacks: SchedulerCallbacks,
    options: SchedulerOptions = {},
  ) {
    this.runners = { ...CHECK_RUNNERS, ...options.runners };
    this.softFailRetryMs = options.softFailRetryMs ?? DEFAULT_SOFT_FAIL_RETRY_MS;
    this.reload(settings, targets, lastKnown);
  }

  get isPausedAll(): boolean {
    return this.pausedAll;
  }

  getStates(): LiveCheckState[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.state }));
  }

  start(): void {
    this.started = true;
    this.stopped = false;
    for (const entry of this.entries.values()) {
      if (entry.state.status !== 'PAUSED') this.schedule(entry, 0);
    }
    this.publish();
  }

  reload(settings: AppSettings, targets: TargetConfig[], lastKnown: LastKnownState[] = []): void {
    this.settings = settings;
    const known = new Map(lastKnown.map((item) => [keyFor(item.targetId, item.checkId), item]));
    const wanted = new Set<string>();
    for (const target of targets) {
      for (const check of target.checks) {
        const key = keyFor(target.id, check.id);
        wanted.add(key);
        const existing = this.entries.get(key);
        if (existing) this.updateEntry(existing, target, check);
        else this.createEntry(key, target, check, known.get(key));
      }
    }
    for (const [key, entry] of this.entries) {
      if (!wanted.has(key)) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.controller?.abort();
        this.entries.delete(key);
      }
    }
    this.publish();
  }

  private isPaused(entry: Entry): boolean {
    return this.pausedAll || entry.pausedByUser || !entry.target.enabled || !entry.check.enabled;
  }

  private createEntry(
    key: string,
    target: TargetConfig,
    check: CheckConfig,
    previous: LastKnownState | undefined,
  ): void {
    const entry: Entry = {
      target,
      check,
      running: false,
      manualQueued: false,
      pausedByUser: false,
      consecutiveFailures: 0,
      waitingOnDependencies: false,
      state: {
        targetId: target.id,
        checkId: check.id,
        status: 'UNKNOWN',
        ...(previous ? { lastKnown: previous, isHistorical: true } : { isHistorical: false }),
      },
    };
    if (this.isPaused(entry)) entry.state = { ...entry.state, status: 'PAUSED' };
    this.entries.set(key, entry);
    if (this.started && !this.isPaused(entry)) this.schedule(entry, 0);
  }

  private updateEntry(entry: Entry, target: TargetConfig, check: CheckConfig): void {
    const intervalChanged =
      effectiveInterval(entry.check, this.settings) !== effectiveInterval(check, this.settings);
    entry.target = target;
    entry.check = check;
    const paused = this.isPaused(entry);
    if (paused && !entry.running) {
      if (entry.state.status !== 'PAUSED') this.recordPaused(entry);
      entry.state = { ...entry.state, status: 'PAUSED', nextRunAt: undefined };
    } else if (!paused && entry.state.status === 'PAUSED') {
      entry.state = { ...entry.state, status: 'UNKNOWN' };
      if (this.started) this.schedule(entry, 0);
    } else if (!paused && intervalChanged && !entry.running && this.started) {
      this.schedule(entry, this.nextDelay(entry));
    }
  }

  runCheck(targetId: string, checkId: string): void {
    const entry = this.entries.get(keyFor(targetId, checkId));
    if (!entry || entry.state.status === 'PAUSED') return;
    if (entry.running) {
      entry.manualQueued = true;
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    this.enqueue(entry);
  }

  runTarget(targetId: string): void {
    for (const entry of this.entries.values())
      if (entry.target.id === targetId) this.runCheck(targetId, entry.check.id);
  }

  runAll(): void {
    for (const entry of this.entries.values()) this.runCheck(entry.target.id, entry.check.id);
  }

  pauseCheck(targetId: string, checkId: string): void {
    const entry = this.entries.get(keyFor(targetId, checkId));
    if (!entry) return;
    entry.pausedByUser = true;
    this.applyPause(entry);
    this.publish();
  }

  resumeCheck(targetId: string, checkId: string): void {
    const entry = this.entries.get(keyFor(targetId, checkId));
    if (!entry) return;
    entry.pausedByUser = false;
    this.applyResume(entry);
    this.publish();
  }

  /** Pauses every check for the session without disturbing individual per-check pauses. */
  pauseAllChecks(): void {
    this.pausedAll = true;
    for (const entry of this.entries.values()) this.applyPause(entry);
    this.publish();
  }

  /** Lifts the session-wide pause; checks the operator paused individually stay paused. */
  resumeAllChecks(): void {
    this.pausedAll = false;
    for (const entry of this.entries.values()) this.applyResume(entry);
    this.publish();
  }

  private applyPause(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.manualQueued = false;
    if (entry.running || entry.state.status === 'PAUSED') return;
    entry.state = { ...entry.state, status: 'PAUSED', nextRunAt: undefined, isHistorical: false };
    this.recordPaused(entry);
  }

  private applyResume(entry: Entry): void {
    if (this.isPaused(entry) || entry.state.status !== 'PAUSED') return;
    entry.state = { ...entry.state, status: 'UNKNOWN', isHistorical: false };
    entry.consecutiveFailures = 0;
    if (this.started) this.schedule(entry, 0);
  }

  async stop(graceMs = 2_000): Promise<void> {
    this.stopped = true;
    this.started = false;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.controller?.abort();
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (this.activeCount === 0) resolve();
          else setTimeout(poll, 25);
        };
        poll();
      }),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }

  /**
   * Delay until the next run measured from when the last run started, so intervals do not drift.
   * A check that keeps failing past its threshold doubles its interval per extra failure, up to
   * `failure_backoff_max_seconds`, so a dead site is not hammered every interval.
   */
  private nextDelay(entry: Entry): number {
    const baseMs = effectiveInterval(entry.check, this.settings) * 1_000;
    const intervalMs = Math.max(baseMs, this.backoffMs(entry, baseMs));
    if (entry.lastStartedAt === undefined) return intervalMs;
    return Math.max(0, entry.lastStartedAt + intervalMs - Date.now());
  }

  private backoffMs(entry: Entry, baseMs: number): number {
    const capMs = this.settings.failure_backoff_max_seconds * 1_000;
    if (capMs <= 0 || entry.state.status !== 'FAIL') return 0;
    const extra = entry.consecutiveFailures - effectiveFailureThreshold(entry.check);
    if (extra <= 0) return 0;
    return Math.min(capMs, baseMs * 2 ** Math.min(extra, 16));
  }

  /** Current backoff for the UI: milliseconds beyond the normal interval, or undefined. */
  private backoffState(entry: Entry): number | undefined {
    const baseMs = effectiveInterval(entry.check, this.settings) * 1_000;
    const backoff = this.backoffMs(entry, baseMs);
    return backoff > baseMs ? backoff : undefined;
  }

  private entriesOf(targetId: string): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.target.id === targetId);
  }

  /**
   * Looks at the precursors named in `depends_on`. Returns the first one that currently fails
   * (this check is blocked), 'wait' when a precursor has not produced a result yet this session,
   * or undefined when the check may run. Paused precursors never block.
   */
  private dependencyGate(entry: Entry): Entry | 'wait' | undefined {
    for (const dependencyId of entry.check.depends_on ?? []) {
      const precursor = this.entries.get(keyFor(entry.target.id, dependencyId));
      if (!precursor || precursor.state.status === 'PAUSED') continue;
      if (precursor.state.status === 'FAIL') return precursor;
      if (precursor.state.status !== 'PASS') return 'wait';
    }
    return undefined;
  }

  /** Re-queues checks that were waiting on, or blocked by, the given precursor. */
  private releaseDependents(precursor: Entry): void {
    for (const entry of this.entriesOf(precursor.target.id)) {
      if (!entry.check.depends_on?.includes(precursor.check.id)) continue;
      if (entry.running || entry.state.status === 'PAUSED') continue;
      const wasBlocked = entry.state.result?.category === 'blocked';
      if (entry.waitingOnDependencies || (wasBlocked && precursor.state.status === 'PASS')) {
        entry.waitingOnDependencies = false;
        if (entry.timer) clearTimeout(entry.timer);
        this.enqueue(entry);
      }
    }
  }

  private blockedResult(precursor: Entry): CheckResult {
    const at = new Date().toISOString();
    return {
      status: 'FAIL',
      category: 'blocked',
      summary: `Blocked: ${precursor.check.name} is failing (${precursor.state.result?.summary ?? 'no result'})`,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
    };
  }

  private schedule(entry: Entry, delayMs: number): void {
    if (this.stopped || entry.state.status === 'PAUSED') return;
    if (entry.timer) clearTimeout(entry.timer);
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    entry.state = { ...entry.state, nextRunAt };
    entry.timer = setTimeout(() => this.enqueue(entry), delayMs);
  }

  private enqueue(entry: Entry): void {
    if (this.stopped || entry.running || entry.state.status === 'PAUSED') return;
    entry.timer = undefined;
    this.waiting.push(() => this.execute(entry));
    this.pump();
  }

  private pump(): void {
    while (
      !this.stopped &&
      this.activeCount < this.settings.max_concurrent_checks &&
      this.waiting.length > 0
    ) {
      const task = this.waiting.shift();
      if (!task) return;
      this.activeCount += 1;
      void task().finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  private async execute(entry: Entry): Promise<void> {
    if (this.stopped || entry.state.status === 'PAUSED') return;
    const gate = this.dependencyGate(entry);
    if (gate === 'wait') {
      // The precursor is still checking or has never run; it will release this check when done.
      entry.waitingOnDependencies = true;
      entry.state = { ...entry.state, nextRunAt: undefined };
      this.publish();
      return;
    }
    entry.waitingOnDependencies = false;
    entry.running = true;
    entry.controller = new AbortController();
    entry.lastStartedAt = Date.now();
    entry.state = { ...entry.state, status: 'CHECKING', nextRunAt: undefined };
    this.publish();
    const result = gate
      ? this.blockedResult(gate)
      : await this.runSafely(entry, entry.controller.signal);
    entry.running = false;
    entry.controller = undefined;

    // A canceled result is not an observation: never persist it or present it as FAIL.
    if (this.stopped || result.category === 'canceled') {
      entry.state = { ...entry.state, status: this.isPaused(entry) ? 'PAUSED' : 'UNKNOWN' };
      entry.manualQueued = false;
      this.publish();
      return;
    }

    const paused = this.isPaused(entry);
    const softFail = !paused && this.isSoftFailure(entry, result);
    if (!softFail) {
      try {
        await this.callbacks.onResult(entry.target.id, entry.check.id, result);
      } catch (error) {
        this.callbacks.onError?.(`record result ${entry.target.id}/${entry.check.id}`, error);
      }
    }
    entry.state = softFail
      ? { ...entry.state, status: entry.state.result?.status ?? 'UNKNOWN' }
      : {
          ...entry.state,
          status: paused ? 'PAUSED' : result.status,
          result,
          statusSince: statusSince(entry.state, result),
          isHistorical: false,
        };
    const rerun = entry.manualQueued;
    entry.manualQueued = false;
    if (paused) this.recordPaused(entry);
    else if (softFail) this.schedule(entry, Math.min(this.softFailRetryMs, this.nextDelay(entry)));
    else this.schedule(entry, rerun ? 0 : this.nextDelay(entry));
    entry.state = { ...entry.state, backoffMs: this.backoffState(entry) };
    this.releaseDependents(entry);
    this.publish();
  }

  /**
   * Tracks consecutive failures. Returns true when the failure should be retried quietly
   * because the check's `failures_before_fail` threshold has not been reached yet.
   */
  private isSoftFailure(entry: Entry, result: CheckResult): boolean {
    if (result.status === 'PASS') {
      entry.consecutiveFailures = 0;
      return false;
    }
    entry.consecutiveFailures += 1;
    const threshold = effectiveFailureThreshold(entry.check);
    return entry.consecutiveFailures < threshold && entry.state.result?.status !== 'FAIL';
  }

  private async runSafely(entry: Entry, signal: AbortSignal): Promise<CheckResult> {
    try {
      return await this.runners[entry.check.type]({
        target: entry.target,
        check: entry.check,
        settings: this.settings,
        signal,
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      return {
        status: 'FAIL',
        category: 'unexpected',
        summary: `Check failed unexpectedly: ${error instanceof Error ? error.message : 'Unknown error'}`,
        startedAt: completedAt,
        completedAt,
        durationMs: 0,
      };
    }
  }

  private recordPaused(entry: Entry): void {
    void Promise.resolve(this.callbacks.onPaused(entry.target.id, entry.check.id)).catch(
      (error: unknown) =>
        this.callbacks.onError?.(`record pause ${entry.target.id}/${entry.check.id}`, error),
    );
  }

  private publish(): void {
    this.callbacks.onStatesChanged(this.getStates());
  }
}
