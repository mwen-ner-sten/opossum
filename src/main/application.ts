import { readFileSync, writeFileSync } from 'node:fs';
import type { AppSettings, TargetConfig } from '@core/config';
import { Scheduler } from '@core/scheduler';
import { addOfflineGaps, aggregateTargetTimeline, observedAvailability } from '@core/timeline';
import type { LiveCheckState, SessionSummary, TimelineResult } from '@core/models';
import type {
  AppSnapshot,
  DatabaseStats,
  ImportPreview,
  MaintenanceSummary,
  PurgeOptions,
  PurgePreview,
  TimelineRange,
} from '@shared/contracts';
import { PRODUCT } from '@shared/product';
import { DatabaseService } from './storage/database';
import { MaintenanceEngine } from './storage/maintenance';
import { Repositories } from './storage/repositories';
import { exportConfigurationYaml } from './transfer/export';
import { parseConfigurationYaml, previewImport } from './transfer/import';

interface ApplicationEvents {
  status(states: LiveCheckState[]): void;
  configuration(): void;
  maintenance(summary: MaintenanceSummary): void;
}

export class ApplicationService {
  readonly repositories: Repositories;
  readonly session: SessionSummary;
  readonly scheduler: Scheduler;
  readonly maintenance: MaintenanceEngine;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly database: DatabaseService,
    private events: ApplicationEvents,
    private readonly adjacentConfigurationPath?: string,
  ) {
    this.repositories = new Repositories(database.db, database.paths.database);
    this.session = this.repositories.createSession(PRODUCT.version);
    const settings = this.repositories.getSettings();
    const targets = this.repositories.listTargets();
    for (const target of targets) {
      for (const check of target.checks) {
        this.repositories.recordSessionStartState(
          this.session.id,
          target.id,
          check.id,
          target.enabled && check.enabled ? 'UNKNOWN' : 'PAUSED',
        );
      }
    }
    this.scheduler = new Scheduler(settings, targets, this.repositories.getLastKnownStates(), {
      onStatesChanged: (states) => this.events.status(states),
      onResult: (targetId, checkId, result) =>
        this.repositories.recordResult(this.session.id, targetId, checkId, result),
      onPaused: (targetId, checkId) =>
        this.repositories.recordPaused(this.session.id, targetId, checkId),
    });
    this.maintenance = new MaintenanceEngine(this.repositories, (summary) =>
      this.events.maintenance(summary),
    );
  }

  setEventHandlers(events: ApplicationEvents): void {
    this.events = events;
  }

  start(): void {
    this.scheduler.start();
    this.maintenance.start(this.repositories.getSettings());
    this.heartbeatTimer = setInterval(() => this.repositories.heartbeat(this.session.id), 30_000);
  }

  getSnapshot(): AppSnapshot {
    return {
      settings: this.repositories.getSettings(),
      targets: this.repositories.listTargets(),
      states: this.scheduler.getStates(),
      session: this.session,
      databaseHealthy: true,
      pausedAll: this.scheduler.isPausedAll,
      ...(this.adjacentConfigurationPath
        ? { adjacentConfigurationPath: this.adjacentConfigurationPath }
        : {}),
    };
  }

  refreshConfiguration(): void {
    this.scheduler.reload(this.repositories.getSettings(), this.repositories.listTargets());
    this.events.configuration();
  }

  saveTarget(target: TargetConfig): void {
    this.repositories.saveTarget(target);
    this.refreshConfiguration();
  }
  saveSettings(settings: AppSettings): void {
    this.repositories.saveSettings(settings);
    this.refreshConfiguration();
  }
  deleteTarget(targetId: string): void {
    this.repositories.deleteTarget(targetId);
    this.refreshConfiguration();
  }
  deleteCheck(targetId: string, checkId: string): void {
    this.repositories.deleteCheck(targetId, checkId);
    this.refreshConfiguration();
  }

  importFromFile(
    filePath: string,
    mode?: 'replace' | 'add-only',
  ): ImportPreview | { imported: true } {
    const configuration = parseConfigurationYaml(readFileSync(filePath, 'utf8'));
    const preview = previewImport(
      filePath,
      configuration,
      this.repositories.listTargets(),
      this.repositories.listTargets(true),
    );
    if (!mode) return preview;
    if (mode === 'replace')
      this.repositories.replaceActiveConfiguration(configuration.app, configuration.targets);
    else this.repositories.addOnlyTargets(configuration.targets);
    this.refreshConfiguration();
    return { imported: true };
  }

  exportToFile(filePath: string, targetIds?: string[]): void {
    const targets = this.repositories
      .listTargets()
      .filter((target) => !targetIds || targetIds.includes(target.id));
    writeFileSync(
      filePath,
      exportConfigurationYaml(this.repositories.getSettings(), targets),
      'utf8',
    );
  }

  getTimeline(
    targetId: string,
    checkId: string | undefined,
    range: TimelineRange,
    sessionId?: string,
  ): TimelineResult {
    const sessions = this.repositories.listSessions(10_000);
    const current = sessions.find((session) => session.id === this.session.id) ?? this.session;
    const previous = sessions.find((session) => session.id !== this.session.id);
    const end = new Date();
    let start: Date;
    let rangeEnd = end;
    const selectedSession = sessionId
      ? sessions.find((session) => session.id === sessionId)
      : undefined;
    if (selectedSession) {
      start = new Date(selectedSession.startedAt);
      rangeEnd = new Date(
        selectedSession.endedAt ?? selectedSession.inferredEndAt ?? selectedSession.lastHeartbeatAt,
      );
    } else if (range === 'current') start = new Date(current.startedAt);
    else if (range === 'previous' && previous) {
      start = new Date(previous.startedAt);
      rangeEnd = new Date(previous.endedAt ?? previous.inferredEndAt ?? previous.lastHeartbeatAt);
    } else if (range === '24h') start = new Date(end.getTime() - 86_400_000);
    else if (range === '7d') start = new Date(end.getTime() - 7 * 86_400_000);
    else if (range === '30d') start = new Date(end.getTime() - 30 * 86_400_000);
    else start = new Date(sessions.at(-1)?.startedAt ?? current.startedAt);
    const raw = this.repositories.getTimeline(
      targetId,
      checkId,
      start.toISOString(),
      rangeEnd.toISOString(),
    );
    const base = checkId ? raw : aggregateTargetTimeline(raw);
    const segments = addOfflineGaps(base, start.toISOString(), rangeEnd.toISOString());
    const availability = observedAvailability(segments);
    return {
      startAt: start.toISOString(),
      endAt: rangeEnd.toISOString(),
      segments,
      ...(availability === undefined ? {} : { observedAvailability: availability }),
    };
  }

  previewPurge(options: PurgeOptions): PurgePreview {
    return this.repositories.previewPurge(options);
  }
  purge(options: PurgeOptions): MaintenanceSummary {
    const result = this.repositories.purgeHistory(options);
    this.events.maintenance(result);
    return result;
  }
  async optimize(fullVacuum: boolean): Promise<MaintenanceSummary> {
    const wasPaused = this.scheduler.isPausedAll;
    if (fullVacuum && !wasPaused) {
      this.scheduler.pauseAllChecks();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const result = this.repositories.optimize(fullVacuum);
    if (fullVacuum && !wasPaused) this.scheduler.resumeAllChecks();
    this.events.maintenance(result);
    return result;
  }
  getStats(): DatabaseStats {
    return this.repositories.getDatabaseStats();
  }

  async shutdown(): Promise<void> {
    this.maintenance.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.scheduler.stop();
    this.repositories.closeSession(this.session.id);
    this.database.close();
  }
}
