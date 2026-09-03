import { readFileSync, writeFileSync } from 'node:fs';
import type { AppSettings, TargetConfig } from '@core/config';
import { Scheduler } from '@core/scheduler';
import { addOfflineGaps, aggregateTargetTimeline, observedAvailability } from '@core/timeline';
import type { LiveCheckState, SessionSummary, TimelineResult } from '@core/models';
import type {
  AppSnapshot,
  DatabaseStats,
  ImportMode,
  ImportPreview,
  MaintenanceSummary,
  PurgeOptions,
  PurgePreview,
  TimelineRange,
} from '@shared/contracts';
import { OpossumError } from '@shared/errors';
import { PRODUCT } from '@shared/product';
import { DatabaseService } from './storage/database';
import { MaintenanceEngine } from './storage/maintenance';
import { Repositories } from './storage/repositories';
import { exportConfigurationYaml } from './transfer/export';
import { parseConfigurationYaml, previewImport } from './transfer/import';

export interface ApplicationEvents {
  status(states: LiveCheckState[]): void;
  configuration(): void;
  maintenance(summary: MaintenanceSummary): void;
  health(healthy: boolean): void;
}

export interface Logger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const noEvents: ApplicationEvents = {
  status: () => undefined,
  configuration: () => undefined,
  maintenance: () => undefined,
  health: () => undefined,
};
/** Consecutive persistence failures before the database is reported unhealthy. */
const UNHEALTHY_AFTER_FAILURES = 3;
const DAY_MS = 86_400_000;

export interface ApplicationOptions {
  events?: ApplicationEvents;
  logger?: Logger;
  adjacentConfigurationPath?: string;
  /** Raw YAML for the bundled example configuration offered on first run. */
  exampleConfigurationYaml?: string;
}

export class ApplicationService {
  readonly repositories: Repositories;
  readonly session: SessionSummary;
  readonly scheduler: Scheduler;
  readonly maintenance: MaintenanceEngine;
  private events: ApplicationEvents;
  private readonly logger: Logger;
  private readonly adjacentConfigurationPath: string | undefined;
  private readonly exampleConfigurationYaml: string | undefined;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private persistenceFailures = 0;
  private databaseHealthy = true;

  constructor(
    readonly database: DatabaseService,
    options: ApplicationOptions = {},
  ) {
    this.events = options.events ?? noEvents;
    this.logger = options.logger ?? silentLogger;
    this.adjacentConfigurationPath = options.adjacentConfigurationPath;
    this.exampleConfigurationYaml = options.exampleConfigurationYaml;
    this.repositories = new Repositories(database.db, database.paths.database, (message) =>
      this.logger.warn(message),
    );
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
      onResult: (targetId, checkId, result) => {
        this.repositories.recordResult(this.session.id, targetId, checkId, result);
        this.notePersistenceSuccess();
      },
      onPaused: (targetId, checkId) => {
        this.repositories.recordPaused(this.session.id, targetId, checkId);
        this.notePersistenceSuccess();
      },
      onError: (context, error) => this.notePersistenceFailure(context, error),
    });
    this.maintenance = new MaintenanceEngine(
      this.repositories,
      (summary) => this.events.maintenance(summary),
      (error) => this.logger.error('Maintenance failed', error),
    );
  }

  setEventHandlers(events: ApplicationEvents): void {
    this.events = events;
  }

  start(): void {
    this.scheduler.start();
    this.maintenance.start(this.repositories.getSettings());
    this.heartbeatTimer = setInterval(() => {
      try {
        this.repositories.heartbeat(this.session.id);
      } catch (error) {
        this.notePersistenceFailure('heartbeat', error);
      }
    }, 30_000);
    this.logger.info(`Session ${this.session.id} started (${PRODUCT.name} ${PRODUCT.version})`);
  }

  private notePersistenceSuccess(): void {
    this.persistenceFailures = 0;
    if (!this.databaseHealthy) {
      this.databaseHealthy = true;
      this.logger.info('Database writes recovered');
      this.events.health(true);
    }
  }

  private notePersistenceFailure(context: string, error: unknown): void {
    this.persistenceFailures += 1;
    this.logger.error(`Database write failed (${context})`, error);
    if (this.databaseHealthy && this.persistenceFailures >= UNHEALTHY_AFTER_FAILURES) {
      this.databaseHealthy = false;
      this.events.health(false);
    }
  }

  getSnapshot(): AppSnapshot {
    return {
      settings: this.repositories.getSettings(),
      targets: this.repositories.listTargets(),
      states: this.scheduler.getStates(),
      session: this.session,
      databaseHealthy: this.databaseHealthy,
      pausedAll: this.scheduler.isPausedAll,
      version: PRODUCT.version,
      hasExampleConfiguration: Boolean(this.exampleConfigurationYaml),
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

  importFromFile(filePath: string, mode?: ImportMode): ImportPreview | { imported: true } {
    return this.importYaml(readFileSync(filePath, 'utf8'), filePath, mode);
  }

  importExample(mode?: ImportMode): ImportPreview | { imported: true } {
    if (!this.exampleConfigurationYaml)
      throw new OpossumError('NOT_FOUND', 'No example configuration is bundled with this build.');
    return this.importYaml(this.exampleConfigurationYaml, 'opossum.example.yaml', mode);
  }

  private importYaml(
    source: string,
    label: string,
    mode?: ImportMode,
  ): ImportPreview | { imported: true } {
    const configuration = parseConfigurationYaml(source);
    const preview = previewImport(
      label,
      configuration,
      this.repositories.listTargets(),
      this.repositories.listTargets(true),
    );
    if (!mode) return preview;
    if (mode === 'replace')
      this.repositories.replaceActiveConfiguration(configuration.app, configuration.targets);
    else this.repositories.addOnlyTargets(configuration.targets);
    this.logger.info(`Imported configuration from ${label} (${mode})`);
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

  /** Resolves the [start, end] window for a timeline request. Returns undefined when no data can exist. */
  private timelineWindow(
    range: TimelineRange,
    sessionId?: string,
  ): { start: Date; end: Date } | undefined {
    const now = new Date();
    const sessionEnd = (session: SessionSummary): Date =>
      new Date(session.endedAt ?? session.inferredEndAt ?? session.lastHeartbeatAt);
    if (sessionId) {
      const selected = this.repositories.sessions.get(sessionId);
      if (!selected) return undefined;
      return {
        start: new Date(selected.startedAt),
        end: selected.endedAt || selected.id !== this.session.id ? sessionEnd(selected) : now,
      };
    }
    switch (range) {
      case 'current':
        return { start: new Date(this.session.startedAt), end: now };
      case 'previous': {
        const previous = this.repositories.sessions.latestOther(this.session.id);
        return previous
          ? { start: new Date(previous.startedAt), end: sessionEnd(previous) }
          : undefined;
      }
      case '24h':
        return { start: new Date(now.getTime() - DAY_MS), end: now };
      case '7d':
        return { start: new Date(now.getTime() - 7 * DAY_MS), end: now };
      case '30d':
        return { start: new Date(now.getTime() - 30 * DAY_MS), end: now };
      case 'all':
        return {
          start: new Date(this.repositories.sessions.oldestStart() ?? this.session.startedAt),
          end: now,
        };
    }
  }

  getTimeline(
    targetId: string,
    checkId: string | undefined,
    range: TimelineRange,
    sessionId?: string,
  ): TimelineResult {
    const window = this.timelineWindow(range, sessionId);
    if (!window) {
      const at = new Date().toISOString();
      return { startAt: at, endAt: at, segments: [] };
    }
    const startAt = window.start.toISOString();
    const endAt = window.end.toISOString();
    const raw = this.repositories.getTimeline(targetId, checkId, startAt, endAt);
    const base = checkId ? raw : aggregateTargetTimeline(raw);
    const segments = addOfflineGaps(base, startAt, endAt);
    const availability = observedAvailability(segments);
    return {
      startAt,
      endAt,
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
    if (result.error) {
      this.logger.error('Manual purge failed', result.error);
      throw new OpossumError('DATABASE', `History purge failed: ${result.error}`, result);
    }
    return result;
  }

  /**
   * better-sqlite3 serialises every statement on one connection, so a vacuum cannot interleave
   * with check writes; there is no need to pause monitoring and disturb the timeline for it.
   */
  optimize(fullVacuum: boolean): MaintenanceSummary {
    const result = this.repositories.optimize(fullVacuum);
    this.events.maintenance(result);
    if (result.error) {
      this.logger.error('Optimization failed', result.error);
      throw new OpossumError('DATABASE', `Optimization failed: ${result.error}`, result);
    }
    return result;
  }

  getStats(): DatabaseStats {
    return this.repositories.getDatabaseStats();
  }

  async shutdown(): Promise<void> {
    this.maintenance.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.scheduler.stop();
    try {
      this.repositories.closeSession(this.session.id);
    } catch (error) {
      this.logger.error('Could not close session cleanly', error);
    }
    this.database.close();
    this.logger.info(`Session ${this.session.id} closed`);
  }
}
