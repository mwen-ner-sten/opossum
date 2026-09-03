import type { AppSettings } from '@core/config';
import type { MaintenanceSummary } from '@shared/contracts';
import { Repositories } from './repositories';

const SIX_HOURS = 6 * 60 * 60 * 1_000;

export class MaintenanceEngine {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly repositories: Repositories,
    private readonly onComplete: (summary: MaintenanceSummary) => void,
  ) {}

  start(settings: AppSettings): void {
    if (settings.maintenance_on_startup) void this.runBounded(settings);
    this.timer = setInterval(
      () => void this.runBounded(this.repositories.getSettings()),
      SIX_HOURS,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  runBounded(settings: AppSettings): MaintenanceSummary | undefined {
    let latest: MaintenanceSummary | undefined;
    if (settings.history_max_age_days > 0) {
      const cutoff = new Date(
        Date.now() - settings.history_max_age_days * 86_400_000,
      ).toISOString();
      latest = this.repositories.purgeHistory({ before: cutoff }, 'automatic-age');
      this.onComplete(latest);
    }
    const maximumBytes = settings.history_max_database_mb * 1024 * 1024;
    if (maximumBytes > 0) {
      let stats = this.repositories.getDatabaseStats();
      const target = maximumBytes * 0.85;
      let batches = 0;
      while (stats.totalBytes > target && batches < 20) {
        const oldest = this.repositories.getOldestClosedSessionId();
        if (!oldest) break;
        latest = this.repositories.purgeHistory({ sessionIds: [oldest] }, 'automatic-size');
        this.onComplete(latest);
        this.repositories.optimize(false);
        stats = this.repositories.getDatabaseStats();
        batches += 1;
      }
    }
    this.repositories.optimize(false);
    return latest;
  }
}
