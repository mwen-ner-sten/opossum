import type { AppSettings } from '@core/config';
import type { MaintenanceSummary } from '@shared/contracts';
import { Repositories } from './repositories';

const SIX_HOURS = 6 * 60 * 60 * 1_000;
/** Startup maintenance waits this long so the first round of checks is enqueued first. */
const STARTUP_DELAY_MS = 1_500;
const MAX_SIZE_BATCHES = 20;
const SIZE_TARGET_RATIO = 0.85;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class MaintenanceEngine {
  private timer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(
    private readonly repositories: Repositories,
    private readonly onComplete: (summary: MaintenanceSummary) => void,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(settings: AppSettings): void {
    if (settings.maintenance_on_startup)
      this.startupTimer = setTimeout(() => void this.runBounded(settings), STARTUP_DELAY_MS);
    this.timer = setInterval(
      () => void this.runBounded(this.repositories.getSettings()),
      SIX_HOURS,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  /**
   * Age purge first, then the size guard, then bounded optimization. Yields to the event loop
   * between batches so IPC and live checks keep flowing while history is trimmed.
   */
  async runBounded(settings: AppSettings): Promise<MaintenanceSummary | undefined> {
    if (this.running) return undefined;
    this.running = true;
    let latest: MaintenanceSummary | undefined;
    try {
      if (settings.history_max_age_days > 0) {
        const cutoff = new Date(
          Date.now() - settings.history_max_age_days * 86_400_000,
        ).toISOString();
        latest = this.report(this.repositories.purgeHistory({ before: cutoff }, 'automatic-age'));
        await yieldToEventLoop();
      }
      const maximumBytes = settings.history_max_database_mb * 1024 * 1024;
      if (maximumBytes > 0) {
        const target = maximumBytes * SIZE_TARGET_RATIO;
        for (let batch = 0; batch < MAX_SIZE_BATCHES; batch += 1) {
          if (this.repositories.getDatabaseStats().totalBytes <= target) break;
          const oldest = this.repositories.getOldestClosedSessionId();
          if (!oldest) break;
          latest = this.report(
            this.repositories.purgeHistory({ sessionIds: [oldest] }, 'automatic-size'),
          );
          if (latest.error) break; // a failing session would repeat forever; leave it for the log
          this.repositories.optimize(false);
          await yieldToEventLoop();
        }
      }
      this.repositories.optimize(false);
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
    return latest;
  }

  private report(summary: MaintenanceSummary): MaintenanceSummary {
    if (summary.error) this.onError(new Error(`${summary.reason}: ${summary.error}`));
    // Only surface runs that changed something; a no-op purge at every startup is noise.
    if (summary.intervalsRemoved > 0 || summary.sessionsRemoved > 0 || summary.error)
      this.onComplete(summary);
    return summary;
  }
}
