import type Database from 'better-sqlite3';
import type { AppSettings, CheckConfig, CheckTemplate, TargetConfig } from '@core/config';
import type { CheckResult, LastKnownState, SessionSummary, TimelineSegment } from '@core/models';
import type {
  DatabaseStats,
  HistoricalDefinition,
  MaintenanceSummary,
  PurgeOptions,
  PurgePreview,
} from '@shared/contracts';
import { HistoryRepository } from './history-repository';
import { MaintenanceRepository } from './maintenance-repository';
import { SessionRepository } from './session-repository';
import { SettingsRepository } from './settings-repository';
import type { InternalIds } from './sql';
import { TargetRepository } from './target-repository';
import { TemplateRepository } from './template-repository';

/**
 * Facade over the storage modules. Callers can use the domain repositories directly; this
 * class keeps a single stable surface for the application service and tests.
 */
export class Repositories {
  readonly settings: SettingsRepository;
  readonly targets: TargetRepository;
  readonly templates: TemplateRepository;
  readonly sessions: SessionRepository;
  readonly history: HistoryRepository;
  readonly maintenance: MaintenanceRepository;

  constructor(
    private readonly db: Database.Database,
    databasePath: string,
    onWarning: (message: string) => void = () => undefined,
  ) {
    this.settings = new SettingsRepository(db);
    this.targets = new TargetRepository(db, onWarning);
    this.templates = new TemplateRepository(db, onWarning);
    this.targets.setTemplateResolver((id) => this.templates.get(id));
    this.sessions = new SessionRepository(db);
    this.history = new HistoryRepository(db, this.targets);
    this.maintenance = new MaintenanceRepository(db, databasePath, this.targets);
  }

  getSettings(): AppSettings {
    return this.settings.get();
  }
  saveSettings(settings: AppSettings): void {
    this.settings.save(settings);
  }

  listTargets(includeDeleted = false): TargetConfig[] {
    return this.targets.list(includeDeleted);
  }
  getInternalIds(targetId: string, checkId?: string): InternalIds {
    return this.targets.internalIds(targetId, checkId);
  }
  saveTarget(target: TargetConfig, replaceChecks = true): void {
    this.targets.save(target, replaceChecks);
  }
  saveCheck(targetId: string, check: CheckConfig, originalCheckId?: string): void {
    this.targets.saveCheck(targetId, check, originalCheckId);
  }
  deleteTarget(targetId: string): void {
    this.targets.delete(targetId);
  }
  deleteCheck(targetId: string, checkId: string): void {
    this.targets.deleteCheck(targetId, checkId);
  }
  removeUnusedDeletedItems(): void {
    this.targets.removeUnusedDeleted();
  }
  listHistoricalDefinitions(): HistoricalDefinition[] {
    return this.targets.listHistoricalDefinitions();
  }

  listTemplates(): CheckTemplate[] {
    return this.templates.list();
  }
  /** Saves a template and regenerates inherited checks on every linked target. Returns that count. */
  saveTemplate(template: CheckTemplate): number {
    return this.db.transaction(() => {
      this.templates.save(template);
      return this.targets.rematerialize(template.id);
    })();
  }
  deleteTemplate(templateId: string): void {
    this.templates.delete(templateId);
  }

  /**
   * Import mode "replace": upsert every template and target in the file, soft-delete active
   * targets absent from it. Templates are never deleted by an import.
   */
  replaceActiveConfiguration(
    settings: AppSettings | undefined,
    targets: TargetConfig[],
    templates: CheckTemplate[] = [],
  ): void {
    this.db.transaction(() => {
      if (settings) this.settings.save(settings);
      for (const template of templates) this.templates.save(template);
      for (const target of targets) this.targets.save(target, true);
      this.targets.softDeleteAbsent(targets.map((target) => target.id));
    })();
  }

  /** Import mode "add only": create templates and targets whose IDs have never existed locally. */
  addOnlyTargets(targets: TargetConfig[], templates: CheckTemplate[] = []): void {
    this.db.transaction(() => {
      const knownTemplates = this.templates.knownIds();
      for (const template of templates)
        if (!knownTemplates.has(template.id)) this.templates.save(template);
      const known = this.targets.knownIds();
      for (const target of targets) if (!known.has(target.id)) this.targets.save(target, true);
    })();
  }

  createSession(applicationVersion: string): SessionSummary {
    return this.sessions.create(applicationVersion);
  }
  heartbeat(sessionId: string): void {
    this.sessions.heartbeat(sessionId);
  }
  closeSession(sessionId: string): void {
    this.sessions.close(sessionId);
  }
  listSessions(limit = 100, before?: string): SessionSummary[] {
    return this.sessions.list(limit, before);
  }
  getOldestClosedSessionId(): string | undefined {
    return this.sessions.oldestClosedId();
  }

  getLastKnownStates(): LastKnownState[] {
    return this.history.lastKnownStates();
  }
  recordResult(sessionId: string, targetId: string, checkId: string, result: CheckResult): void {
    this.history.recordResult(sessionId, targetId, checkId, result);
  }
  recordSessionStartState(
    sessionId: string,
    targetId: string,
    checkId: string,
    status: 'UNKNOWN' | 'PAUSED',
  ): void {
    this.history.recordSessionStartState(sessionId, targetId, checkId, status);
  }
  recordPaused(sessionId: string, targetId: string, checkId: string): void {
    this.history.recordPaused(sessionId, targetId, checkId);
  }
  getTimeline(
    targetId: string,
    checkId: string | undefined,
    startAt: string,
    endAt: string,
  ): TimelineSegment[] {
    return this.history.timeline(targetId, checkId, startAt, endAt);
  }

  previewPurge(options: PurgeOptions): PurgePreview {
    return this.maintenance.previewPurge(options);
  }
  purgeHistory(options: PurgeOptions, reason = 'manual'): MaintenanceSummary {
    return this.maintenance.purgeHistory(options, reason);
  }
  getDatabaseStats(): DatabaseStats {
    return this.maintenance.databaseStats();
  }
  optimize(fullVacuum = false): MaintenanceSummary {
    return this.maintenance.optimize(fullVacuum);
  }
}
