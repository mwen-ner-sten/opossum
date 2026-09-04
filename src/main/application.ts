import { writeFileSync } from 'node:fs';
import type { AppSettings, CheckTemplate, PortableConfiguration, TargetConfig } from '@core/config';
import { assessCapacity } from '@core/capacity';
import { autoDetectMapping, buildTargetsFromRows } from '@core/import-mapping';
import { resolveChecksPartial, validateTemplate } from '@core/templates';
import { Scheduler } from '@core/scheduler';
import { addOfflineGaps, aggregateTargetTimeline, observedAvailability } from '@core/timeline';
import type { LiveCheckState, SessionSummary, TimelineResult } from '@core/models';
import type {
  AppSnapshot,
  DatabaseStats,
  ImportMode,
  ImportPreview,
  ImportResult,
  MaintenanceSummary,
  PurgeOptions,
  PurgePreview,
  TableImportOptions,
  TableImportPreview,
  TableImportSource,
  TimelineRange,
} from '@shared/contracts';
import { OpossumError } from '@shared/errors';
import { PRODUCT } from '@shared/product';
import { DatabaseService } from './storage/database';
import { MaintenanceEngine } from './storage/maintenance';
import { Repositories } from './storage/repositories';
import { exportConfigurationYaml } from './transfer/export';
import {
  parseConfigurationDocument,
  parseConfigurationYaml,
  previewImport,
} from './transfer/import';
import {
  parseDelimitedText,
  readImportSource,
  withRaw,
  type TableSource,
} from './transfer/sources';

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

/** Expanded checks for a capacity projection; falls back to own checks if expansion fails. */
function projectedChecks(target: TargetConfig, template: CheckTemplate | undefined) {
  try {
    return resolveChecksPartial(target, template).checks;
  } catch {
    return target.checks;
  }
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
    this.logger.info(
      `Session ${this.session.id} started (${PRODUCT.name} ${PRODUCT.buildVersion})`,
    );
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
      templates: this.repositories.listTemplates(),
      capacity: assessCapacity(this.repositories.getSettings(), this.repositories.listTargets()),
      states: this.scheduler.getStates(),
      session: this.session,
      databaseHealthy: this.databaseHealthy,
      pausedAll: this.scheduler.isPausedAll,
      version: PRODUCT.version,
      buildVersion: PRODUCT.buildVersion,
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

  listTemplates(): CheckTemplate[] {
    return this.repositories.listTemplates();
  }
  /** Validates, saves, and regenerates every linked target. Returns how many were relinked. */
  saveTemplate(input: unknown): { relinked: number } {
    const { template, issues } = validateTemplate(input);
    if (!template)
      throw new OpossumError(
        'VALIDATION',
        `Template has ${issues.length} problem${issues.length === 1 ? '' : 's'}.`,
        issues,
      );
    const relinked = this.repositories.saveTemplate(template);
    this.logger.info(`Saved template ${template.id} (${relinked} linked targets regenerated)`);
    this.refreshConfiguration();
    return { relinked };
  }
  deleteTemplate(templateId: string): void {
    this.repositories.deleteTemplate(templateId);
    this.refreshConfiguration();
  }

  /**
   * Opens any supported file. Full OPOSSUM configurations follow the classic preview/apply path;
   * everything else comes back as a table for the import builder to map.
   */
  async importFromFile(filePath: string, mode?: ImportMode): Promise<ImportResult> {
    const source = await readImportSource(filePath);
    if (source.kind === 'configuration')
      return this.importConfiguration(parseConfigurationDocument(source.document), filePath, mode);
    return this.describeTable(filePath, source);
  }

  /** Opens pasted CSV or TSV text in the import builder. */
  importFromText(text: string): TableImportSource {
    const format = text.includes('\t') ? 'tsv' : 'csv';
    const source = withRaw(parseDelimitedText(text, format), text);
    return this.describeTable('', source as TableSource);
  }

  private describeTable(filePath: string, source: TableSource): TableImportSource {
    return {
      kind: 'table',
      filePath,
      format: source.format,
      columns: source.columns,
      rowCount: source.rows.length,
      sample: source.rows.slice(0, 25),
      ...(source.sheets ? { sheets: source.sheets } : {}),
      ...(source.sheet ? { sheet: source.sheet } : {}),
      ...(source.flavour ? { flavour: source.flavour } : {}),
      ...(source.raw ? { rawPreview: source.raw } : {}),
      suggestedMapping: autoDetectMapping(source.columns),
    };
  }

  private async loadTable(options: TableImportOptions): Promise<TableSource> {
    if (options.text)
      return parseDelimitedText(options.text, options.text.includes('\t') ? 'tsv' : 'csv');
    if (!options.filePath)
      throw new OpossumError('VALIDATION', 'Choose a file or paste text first.');
    const source = await readImportSource(options.filePath, options.sheet);
    if (source.kind !== 'table')
      throw new OpossumError(
        'VALIDATION',
        'This file is a full configuration; import it directly.',
      );
    return source;
  }

  /** Builds targets from the mapped table and reports how they would merge with local data. */
  async previewTableImport(options: TableImportOptions): Promise<TableImportPreview> {
    const source = await this.loadTable(options);
    const templates = this.repositories.listTemplates();
    const { targets, issues, partial } = buildTargetsFromRows(
      source.rows,
      options.mapping,
      templates,
    );
    const settings = this.repositories.getSettings();
    const existing = this.repositories.listTargets();
    const incomingIds = new Set(targets.map((target) => target.id));
    const templateById = new Map(templates.map((template) => [template.id, template]));
    // Expand inherited checks so the projection counts what the scheduler would actually run.
    const projected = [
      ...existing.filter((target) => !incomingIds.has(target.id)),
      ...targets.map((target) => ({
        ...target,
        checks: projectedChecks(target, templateById.get(target.template ?? '')),
      })),
    ];
    const projectedCapacity = assessCapacity(settings, projected);
    const preview = previewImport(
      options.filePath ?? 'pasted text',
      {
        format_version: 1,
        exported_at: new Date().toISOString(),
        application_version: PRODUCT.version,
        app: this.repositories.getSettings(),
        templates: [],
        targets,
      },
      this.repositories.listTargets(),
      this.repositories.listTargets(true),
      templates,
    );
    return { targets, issues, partial, preview, projectedCapacity };
  }

  async applyTableImport(options: TableImportOptions): Promise<{ imported: number }> {
    const { targets, issues } = await this.previewTableImport(options);
    if (targets.length === 0)
      throw new OpossumError('VALIDATION', 'No rows could be turned into targets.', issues);
    if (options.mode === 'replace')
      this.repositories.replaceActiveConfiguration(undefined, targets);
    else this.repositories.addOnlyTargets(targets);
    this.logger.info(
      `Imported ${targets.length} targets from ${options.filePath ?? 'pasted text'} (${options.mode ?? 'add-only'})`,
    );
    this.refreshConfiguration();
    return { imported: targets.length };
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
    return this.importConfiguration(parseConfigurationYaml(source), label, mode);
  }

  private importConfiguration(
    configuration: PortableConfiguration,
    label: string,
    mode?: ImportMode,
  ): ImportPreview | { imported: true } {
    const preview = previewImport(
      label,
      configuration,
      this.repositories.listTargets(),
      this.repositories.listTargets(true),
      this.repositories.listTemplates(),
    );
    if (!mode) return preview;
    if (mode === 'replace')
      this.repositories.replaceActiveConfiguration(
        configuration.app,
        configuration.targets,
        configuration.templates,
      );
    else this.repositories.addOnlyTargets(configuration.targets, configuration.templates);
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
      exportConfigurationYaml(
        this.repositories.getSettings(),
        targets,
        this.repositories.listTemplates(),
      ),
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
