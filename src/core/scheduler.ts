import { effectiveInterval, type AppSettings, type CheckConfig, type TargetConfig } from './config';
import { CHECK_RUNNERS } from './checks';
import type { CheckResult, LastKnownState, LiveCheckState } from './models';

interface SchedulerCallbacks {
  onStatesChanged(states: LiveCheckState[]): void;
  onResult(targetId: string, checkId: string, result: CheckResult): Promise<void> | void;
  onPaused(targetId: string, checkId: string): Promise<void> | void;
}

interface Entry {
  target: TargetConfig;
  check: CheckConfig;
  state: LiveCheckState;
  timer?: ReturnType<typeof setTimeout> | undefined;
  controller?: AbortController | undefined;
  running: boolean;
  manualQueued: boolean;
}

const keyFor = (targetId: string, checkId: string): string => `${targetId}\0${checkId}`;

export class Scheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly waiting: Array<() => Promise<void>> = [];
  private activeCount = 0;
  private stopped = false;
  private started = false;
  private pausedAll = false;

  constructor(
    private settings: AppSettings,
    targets: TargetConfig[],
    lastKnown: LastKnownState[],
    private readonly callbacks: SchedulerCallbacks,
  ) {
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
        const paused = !target.enabled || !check.enabled || this.pausedAll;
        const existing = this.entries.get(key);
        if (existing) {
          existing.target = target;
          existing.check = check;
          if (paused && !existing.running)
            existing.state = { ...existing.state, status: 'PAUSED', nextRunAt: undefined };
          else if (!paused && existing.state.status === 'PAUSED') {
            existing.state = { ...existing.state, status: 'UNKNOWN' };
            if (this.started) this.schedule(existing, 0);
          }
        } else {
          const previous = known.get(key);
          const entry: Entry = {
            target,
            check,
            running: false,
            manualQueued: false,
            state: {
              targetId: target.id,
              checkId: check.id,
              status: paused ? 'PAUSED' : 'UNKNOWN',
              ...(previous ? { lastKnown: previous, isHistorical: true } : { isHistorical: false }),
            },
          };
          this.entries.set(key, entry);
          if (this.started && !paused) this.schedule(entry, 0);
        }
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
    if (entry.timer) clearTimeout(entry.timer);
    entry.manualQueued = false;
    entry.state = { ...entry.state, status: 'PAUSED', nextRunAt: undefined, isHistorical: false };
    void this.callbacks.onPaused(targetId, checkId);
    this.publish();
  }

  resumeCheck(targetId: string, checkId: string): void {
    const entry = this.entries.get(keyFor(targetId, checkId));
    if (!entry || !entry.target.enabled || !entry.check.enabled) return;
    entry.state = { ...entry.state, status: 'UNKNOWN', isHistorical: false };
    this.schedule(entry, 0);
    this.publish();
  }

  pauseAllChecks(): void {
    this.pausedAll = true;
    for (const entry of this.entries.values()) this.pauseCheck(entry.target.id, entry.check.id);
  }

  resumeAllChecks(): void {
    this.pausedAll = false;
    for (const entry of this.entries.values()) this.resumeCheck(entry.target.id, entry.check.id);
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
    entry.running = true;
    entry.controller = new AbortController();
    entry.state = { ...entry.state, status: 'CHECKING', nextRunAt: undefined };
    this.publish();
    const runner = CHECK_RUNNERS[entry.check.type];
    let result: CheckResult;
    try {
      result = await runner({
        target: entry.target,
        check: entry.check,
        settings: this.settings,
        signal: entry.controller.signal,
      });
      try {
        await this.callbacks.onResult(entry.target.id, entry.check.id, result);
      } catch {
        /* Keep live monitoring responsive; database health is reported separately. */
      }
    } catch (error) {
      const completedAt = new Date().toISOString();
      result = {
        status: 'FAIL',
        category: 'unexpected',
        summary: `Check failed unexpectedly: ${error instanceof Error ? error.message : 'Unknown error'}`,
        startedAt: completedAt,
        completedAt,
        durationMs: 0,
      };
    } finally {
      entry.running = false;
      entry.controller = undefined;
    }
    const paused =
      this.pausedAll ||
      !entry.target.enabled ||
      !entry.check.enabled ||
      entry.state.status === 'PAUSED';
    entry.state = {
      ...entry.state,
      status: paused ? 'PAUSED' : result.status,
      result,
      isHistorical: false,
    };
    const rerun = entry.manualQueued;
    entry.manualQueued = false;
    if (!paused && !this.stopped)
      this.schedule(entry, rerun ? 0 : effectiveInterval(entry.check, this.settings) * 1_000);
    this.publish();
  }

  private publish(): void {
    this.callbacks.onStatesChanged(this.getStates());
  }
}
