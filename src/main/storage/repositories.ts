import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  checkSchema,
  targetSchema,
  type AppSettings,
  type CheckConfig,
  type TargetConfig,
} from '@core/config';
import type { CheckResult, LastKnownState, SessionSummary, TimelineSegment } from '@core/models';
import type {
  DatabaseStats,
  HistoricalDefinition,
  MaintenanceSummary,
  PurgeOptions,
  PurgePreview,
} from '@shared/contracts';
import { OpossumError } from '@shared/errors';

interface TargetRow {
  internal_id: string;
  config_id: string;
  name: string;
  host: string;
  group_name: string | null;
  description: string | null;
  enabled: number;
  deleted_at: string | null;
}
interface CheckRow {
  internal_id: string;
  target_internal_id: string;
  config_id: string;
  config_json: string;
  deleted_at: string | null;
}

const now = (): string => new Date().toISOString();
const databaseString = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

export class Repositories {
  constructor(
    private readonly db: Database.Database,
    private readonly databasePath: string,
  ) {
    this.ensureSettings();
  }

  private ensureSettings(): void {
    const current = this.db.prepare('SELECT id FROM app_settings WHERE id = 1').get();
    if (current) return;
    const settings = DEFAULT_SETTINGS;
    this.db
      .prepare(
        `INSERT INTO app_settings (
        id, default_interval_seconds, default_timeout_seconds, max_concurrent_checks,
        history_max_age_days, history_max_database_mb, maintenance_on_startup, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        settings.default_interval_seconds,
        settings.default_timeout_seconds,
        settings.max_concurrent_checks,
        settings.history_max_age_days,
        settings.history_max_database_mb,
        Number(settings.maintenance_on_startup),
        now(),
      );
  }

  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as Record<
      string,
      unknown
    >;
    return appSettingsSchema.parse({
      default_interval_seconds: row.default_interval_seconds,
      default_timeout_seconds: row.default_timeout_seconds,
      max_concurrent_checks: row.max_concurrent_checks,
      history_max_age_days: row.history_max_age_days,
      history_max_database_mb: row.history_max_database_mb,
      maintenance_on_startup: Boolean(row.maintenance_on_startup),
    });
  }

  saveSettings(settingsInput: AppSettings): void {
    const settings = appSettingsSchema.parse(settingsInput);
    this.db
      .prepare(
        `UPDATE app_settings SET
      default_interval_seconds = ?, default_timeout_seconds = ?, max_concurrent_checks = ?,
      history_max_age_days = ?, history_max_database_mb = ?, maintenance_on_startup = ?, updated_at = ?
      WHERE id = 1`,
      )
      .run(
        settings.default_interval_seconds,
        settings.default_timeout_seconds,
        settings.max_concurrent_checks,
        settings.history_max_age_days,
        settings.history_max_database_mb,
        Number(settings.maintenance_on_startup),
        now(),
      );
  }

  listTargets(includeDeleted = false): TargetConfig[] {
    const targets = this.db
      .prepare(
        `SELECT * FROM targets ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY lower(COALESCE(group_name, '')), lower(name), config_id`,
      )
      .all() as TargetRow[];
    const checkQuery = this.db.prepare(
      `SELECT * FROM checks WHERE target_internal_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY lower(name), config_id`,
    );
    return targets.map((target) => {
      const checks = (checkQuery.all(target.internal_id) as CheckRow[]).map((row) =>
        checkSchema.parse(JSON.parse(row.config_json)),
      );
      return targetSchema.parse({
        id: target.config_id,
        name: target.name,
        host: target.host,
        ...(target.group_name === null ? {} : { group: target.group_name }),
        ...(target.description === null ? {} : { description: target.description }),
        enabled: Boolean(target.enabled),
        checks,
      });
    });
  }

  getInternalIds(
    targetId: string,
    checkId?: string,
  ): { targetInternalId: string; checkInternalId?: string } {
    const target = this.db
      .prepare('SELECT internal_id FROM targets WHERE config_id = ?')
      .get(targetId) as { internal_id: string } | undefined;
    if (!target) throw new OpossumError('NOT_FOUND', `Target "${targetId}" was not found.`);
    if (checkId === undefined) return { targetInternalId: target.internal_id };
    const check = this.db
      .prepare('SELECT internal_id FROM checks WHERE target_internal_id = ? AND config_id = ?')
      .get(target.internal_id, checkId) as { internal_id: string } | undefined;
    if (!check)
      throw new OpossumError('NOT_FOUND', `Check "${targetId}/${checkId}" was not found.`);
    return { targetInternalId: target.internal_id, checkInternalId: check.internal_id };
  }

  saveTarget(input: TargetConfig, replaceChecks = true): void {
    const target = targetSchema.parse(input);
    this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT internal_id FROM targets WHERE config_id = ?')
        .get(target.id) as { internal_id: string } | undefined;
      const timestamp = now();
      const internalId = existing?.internal_id ?? randomUUID();
      if (existing) {
        this.db
          .prepare(
            `UPDATE targets SET name=?, host=?, group_name=?, description=?, enabled=?, updated_at=?, deleted_at=NULL WHERE internal_id=?`,
          )
          .run(
            target.name,
            target.host,
            target.group ?? null,
            target.description ?? null,
            Number(target.enabled),
            timestamp,
            internalId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO targets(internal_id,config_id,name,host,group_name,description,enabled,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            internalId,
            target.id,
            target.name,
            target.host,
            target.group ?? null,
            target.description ?? null,
            Number(target.enabled),
            timestamp,
            timestamp,
          );
      }
      for (const check of target.checks) this.upsertCheck(internalId, check, undefined);
      if (replaceChecks) {
        const ids = target.checks.map((check) => check.id);
        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(',');
          this.db
            .prepare(
              `UPDATE checks SET deleted_at=?, updated_at=? WHERE target_internal_id=? AND deleted_at IS NULL AND config_id NOT IN (${placeholders})`,
            )
            .run(timestamp, timestamp, internalId, ...ids);
        }
      }
    })();
  }

  saveCheck(targetId: string, checkInput: CheckConfig, originalCheckId?: string): void {
    const check = checkSchema.parse(checkInput);
    this.db.transaction(() => {
      const { targetInternalId } = this.getInternalIds(targetId);
      this.upsertCheck(targetInternalId, check, originalCheckId);
    })();
  }

  private upsertCheck(
    targetInternalId: string,
    check: CheckConfig,
    originalCheckId?: string,
  ): void {
    const lookupId = originalCheckId ?? check.id;
    const existing = this.db
      .prepare('SELECT internal_id FROM checks WHERE target_internal_id = ? AND config_id = ?')
      .get(targetInternalId, lookupId) as { internal_id: string } | undefined;
    if (originalCheckId && originalCheckId !== check.id) {
      const conflict = this.db
        .prepare(
          'SELECT internal_id FROM checks WHERE target_internal_id = ? AND config_id = ? AND internal_id != ?',
        )
        .get(targetInternalId, check.id, existing?.internal_id ?? '') as
        { internal_id: string } | undefined;
      if (conflict) throw new OpossumError('CONFLICT', `Check ID "${check.id}" already exists.`);
    }
    const timestamp = now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE checks SET config_id=?, name=?, type=?, enabled=?, config_json=?, updated_at=?, deleted_at=NULL WHERE internal_id=?`,
        )
        .run(
          check.id,
          check.name,
          check.type,
          Number(check.enabled),
          JSON.stringify(check),
          timestamp,
          existing.internal_id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO checks(internal_id,target_internal_id,config_id,name,type,enabled,config_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          targetInternalId,
          check.id,
          check.name,
          check.type,
          Number(check.enabled),
          JSON.stringify(check),
          timestamp,
          timestamp,
        );
    }
  }

  deleteTarget(targetId: string): void {
    const { targetInternalId } = this.getInternalIds(targetId);
    const timestamp = now();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE targets SET deleted_at=?, updated_at=? WHERE internal_id=?')
        .run(timestamp, timestamp, targetInternalId);
      this.db
        .prepare(
          'UPDATE checks SET deleted_at=?, updated_at=? WHERE target_internal_id=? AND deleted_at IS NULL',
        )
        .run(timestamp, timestamp, targetInternalId);
    })();
  }

  deleteCheck(targetId: string, checkId: string): void {
    const { checkInternalId } = this.getInternalIds(targetId, checkId);
    this.db
      .prepare('UPDATE checks SET deleted_at=?, updated_at=? WHERE internal_id=?')
      .run(now(), now(), checkInternalId);
  }

  replaceActiveConfiguration(settings: AppSettings, targets: TargetConfig[]): void {
    this.db.transaction(() => {
      this.saveSettings(settings);
      for (const target of targets) this.saveTarget(target, true);
      const ids = targets.map((target) => target.id);
      const timestamp = now();
      if (ids.length === 0) {
        this.db
          .prepare('UPDATE targets SET deleted_at=?, updated_at=? WHERE deleted_at IS NULL')
          .run(timestamp, timestamp);
        this.db
          .prepare('UPDATE checks SET deleted_at=?, updated_at=? WHERE deleted_at IS NULL')
          .run(timestamp, timestamp);
      } else {
        const placeholders = ids.map(() => '?').join(',');
        const absent = this.db
          .prepare(
            `SELECT internal_id FROM targets WHERE deleted_at IS NULL AND config_id NOT IN (${placeholders})`,
          )
          .all(...ids) as { internal_id: string }[];
        for (const row of absent) {
          this.db
            .prepare('UPDATE targets SET deleted_at=?, updated_at=? WHERE internal_id=?')
            .run(timestamp, timestamp, row.internal_id);
          this.db
            .prepare(
              'UPDATE checks SET deleted_at=?, updated_at=? WHERE target_internal_id=? AND deleted_at IS NULL',
            )
            .run(timestamp, timestamp, row.internal_id);
        }
      }
    })();
  }

  addOnlyTargets(targets: TargetConfig[]): void {
    this.db.transaction(() => {
      const existing = new Set(
        (this.db.prepare('SELECT config_id FROM targets').all() as { config_id: string }[]).map(
          (row) => row.config_id,
        ),
      );
      for (const target of targets) if (!existing.has(target.id)) this.saveTarget(target, true);
    })();
  }

  createSession(applicationVersion: string): SessionSummary {
    const timestamp = now();
    const id = randomUUID();
    this.db.transaction(() => {
      const abandoned = this.db
        .prepare('SELECT id,last_heartbeat_at FROM sessions WHERE ended_at IS NULL')
        .all() as { id: string; last_heartbeat_at: string }[];
      for (const previous of abandoned) {
        const inferred = new Date(
          new Date(previous.last_heartbeat_at).getTime() + 30_000,
        ).toISOString();
        this.db
          .prepare('UPDATE status_intervals SET ended_at=? WHERE session_id=? AND ended_at IS NULL')
          .run(inferred, previous.id);
        this.db.prepare('UPDATE sessions SET ended_at=? WHERE id=?').run(inferred, previous.id);
      }
      this.db
        .prepare(
          'INSERT INTO sessions(id,started_at,last_heartbeat_at,application_version,clean_shutdown) VALUES(?,?,?,?,0)',
        )
        .run(id, timestamp, timestamp, applicationVersion);
    })();
    return {
      id,
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      applicationVersion,
      cleanShutdown: false,
      passCount: 0,
      failCount: 0,
    };
  }

  heartbeat(sessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET last_heartbeat_at=? WHERE id=? AND ended_at IS NULL')
      .run(now(), sessionId);
  }

  closeSession(sessionId: string): void {
    const timestamp = now();
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE status_intervals SET ended_at=last_observation_at WHERE session_id=? AND ended_at IS NULL',
        )
        .run(sessionId);
      this.db
        .prepare('UPDATE sessions SET ended_at=?, last_heartbeat_at=?, clean_shutdown=1 WHERE id=?')
        .run(timestamp, timestamp, sessionId);
    })();
  }

  listSessions(limit = 100): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
      SUM(CASE WHEN i.status='PASS' THEN 1 ELSE 0 END) pass_count,
      SUM(CASE WHEN i.status='FAIL' THEN 1 ELSE 0 END) fail_count
      FROM sessions s LEFT JOIN status_intervals i ON i.session_id=s.id
      GROUP BY s.id ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => {
      const clean = Boolean(row.clean_shutdown);
      const lastHeartbeatAt = String(row.last_heartbeat_at);
      const inferred =
        !clean && row.ended_at === null
          ? new Date(new Date(lastHeartbeatAt).getTime() + 30_000).toISOString()
          : undefined;
      return {
        id: String(row.id),
        startedAt: String(row.started_at),
        ...(row.ended_at ? { endedAt: databaseString(row.ended_at) } : {}),
        lastHeartbeatAt,
        applicationVersion: String(row.application_version),
        cleanShutdown: clean,
        ...(inferred ? { inferredEndAt: inferred } : {}),
        passCount: Number(row.pass_count ?? 0),
        failCount: Number(row.fail_count ?? 0),
      };
    });
  }

  getLastKnownStates(): LastKnownState[] {
    const rows = this.db
      .prepare(
        `SELECT t.config_id target_id, c.config_id check_id, l.*
      FROM check_last_state l JOIN targets t ON t.internal_id=l.target_internal_id JOIN checks c ON c.internal_id=l.check_internal_id
      WHERE t.deleted_at IS NULL AND c.deleted_at IS NULL`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      targetId: String(row.target_id),
      checkId: String(row.check_id),
      sessionId: String(row.session_id),
      result: {
        status: row.status as 'PASS' | 'FAIL',
        category: row.diagnostic_category as CheckResult['category'],
        summary: String(row.summary),
        startedAt: String(row.started_at),
        completedAt: String(row.completed_at),
        durationMs: Number(row.duration_ms),
        ...(row.details_json
          ? {
              details: JSON.parse(String(row.details_json as string)) as NonNullable<
                CheckResult['details']
              >,
            }
          : {}),
      },
    }));
  }

  recordResult(sessionId: string, targetId: string, checkId: string, result: CheckResult): void {
    const { targetInternalId, checkInternalId } = this.getInternalIds(targetId, checkId);
    if (!checkInternalId) throw new OpossumError('NOT_FOUND', 'Check identity is missing.');
    this.db.transaction(() => {
      const active = this.db
        .prepare(
          `SELECT * FROM status_intervals WHERE session_id=? AND check_internal_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        )
        .get(sessionId, checkInternalId) as Record<string, unknown> | undefined;
      if (
        active &&
        active.status === result.status &&
        active.diagnostic_category === result.category
      ) {
        this.db
          .prepare(
            `UPDATE status_intervals SET last_observation_at=?, observation_count=observation_count+1,
          latest_summary=?, min_duration_ms=MIN(min_duration_ms,?), max_duration_ms=MAX(max_duration_ms,?),
          total_duration_ms=total_duration_ms+? WHERE id=?`,
          )
          .run(
            result.completedAt,
            result.summary,
            result.durationMs,
            result.durationMs,
            result.durationMs,
            active.id,
          );
      } else {
        if (active)
          this.db
            .prepare('UPDATE status_intervals SET ended_at=? WHERE id=?')
            .run(result.startedAt, active.id);
        this.db
          .prepare(
            `INSERT INTO status_intervals(id,session_id,target_internal_id,check_internal_id,started_at,last_observation_at,status,
          diagnostic_category,observation_count,latest_summary,min_duration_ms,max_duration_ms,total_duration_ms)
          VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            sessionId,
            targetInternalId,
            checkInternalId,
            result.startedAt,
            result.completedAt,
            result.status,
            result.category,
            result.summary,
            result.durationMs,
            result.durationMs,
            result.durationMs,
          );
      }
      this.db
        .prepare(
          `INSERT INTO check_last_state(check_internal_id,target_internal_id,session_id,status,diagnostic_category,summary,started_at,completed_at,duration_ms,details_json)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(check_internal_id) DO UPDATE SET target_internal_id=excluded.target_internal_id,
        session_id=excluded.session_id,status=excluded.status,diagnostic_category=excluded.diagnostic_category,summary=excluded.summary,
        started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,details_json=excluded.details_json`,
        )
        .run(
          checkInternalId,
          targetInternalId,
          sessionId,
          result.status,
          result.category,
          result.summary,
          result.startedAt,
          result.completedAt,
          result.durationMs,
          result.details ? JSON.stringify(result.details) : null,
        );
    })();
  }

  recordSessionStartState(
    sessionId: string,
    targetId: string,
    checkId: string,
    status: 'UNKNOWN' | 'PAUSED',
  ): void {
    const { targetInternalId, checkInternalId } = this.getInternalIds(targetId, checkId);
    if (!checkInternalId) return;
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO status_intervals(id,session_id,target_internal_id,check_internal_id,started_at,last_observation_at,status,
      diagnostic_category,observation_count,latest_summary,total_duration_ms) VALUES(?,?,?,?,?,?,?, ?,1,?,0)`,
      )
      .run(
        randomUUID(),
        sessionId,
        targetInternalId,
        checkInternalId,
        timestamp,
        timestamp,
        status,
        status === 'PAUSED' ? 'paused' : 'unknown',
        status === 'PAUSED' ? 'Disabled or paused' : 'Waiting for first result',
      );
  }

  recordPaused(sessionId: string, targetId: string, checkId: string): void {
    const { targetInternalId, checkInternalId } = this.getInternalIds(targetId, checkId);
    if (!checkInternalId) return;
    const timestamp = now();
    this.db.transaction(() => {
      const active = this.db
        .prepare(
          'SELECT id,status FROM status_intervals WHERE session_id=? AND check_internal_id=? AND ended_at IS NULL',
        )
        .get(sessionId, checkInternalId) as { id: string; status: string } | undefined;
      if (active?.status === 'PAUSED') {
        this.db
          .prepare(
            'UPDATE status_intervals SET last_observation_at=?, observation_count=observation_count+1 WHERE id=?',
          )
          .run(timestamp, active.id);
      } else {
        if (active)
          this.db
            .prepare('UPDATE status_intervals SET ended_at=? WHERE id=?')
            .run(timestamp, active.id);
        this.db
          .prepare(
            `INSERT INTO status_intervals(id,session_id,target_internal_id,check_internal_id,started_at,last_observation_at,status,
          diagnostic_category,observation_count,latest_summary,total_duration_ms) VALUES(?,?,?,?,?,?,'PAUSED','paused',1,'Paused',0)`,
          )
          .run(randomUUID(), sessionId, targetInternalId, checkInternalId, timestamp, timestamp);
      }
    })();
  }

  getTimeline(
    targetId: string,
    checkId: string | undefined,
    startAt: string,
    endAt: string,
  ): TimelineSegment[] {
    const ids = this.getInternalIds(targetId, checkId);
    const rows = this.db
      .prepare(
        `SELECT i.*, COALESCE(i.ended_at, s.ended_at, ?) effective_end FROM status_intervals i
      JOIN sessions s ON s.id=i.session_id
      WHERE i.target_internal_id=? ${checkId ? 'AND i.check_internal_id=?' : ''}
      AND i.started_at < ? AND COALESCE(i.ended_at,s.ended_at,?) >= ? ORDER BY i.started_at`,
      )
      .all(
        endAt,
        ids.targetInternalId,
        ...(checkId && ids.checkInternalId ? [ids.checkInternalId] : []),
        endAt,
        endAt,
        startAt,
      ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      startAt: String(row.started_at),
      endAt: String(row.effective_end),
      status: row.status as TimelineSegment['status'],
      category: row.diagnostic_category as CheckResult['category'],
      observationCount: Number(row.observation_count),
      summary: String(row.latest_summary),
      ...(row.min_duration_ms === null ? {} : { minDurationMs: Number(row.min_duration_ms) }),
      ...(row.max_duration_ms === null ? {} : { maxDurationMs: Number(row.max_duration_ms) }),
      ...(Number(row.observation_count) === 0
        ? {}
        : { averageDurationMs: Number(row.total_duration_ms) / Number(row.observation_count) }),
    }));
  }

  previewPurge(options: PurgeOptions): PurgePreview {
    const { where, parameters } = this.purgeWhere(options);
    const cutoffClause = options.before ? ' AND started_at < ?' : '';
    const row = this.db
      .prepare(
        `SELECT COUNT(*) interval_count, COUNT(DISTINCT session_id) session_count,
      MIN(started_at) oldest_at, MAX(last_observation_at) newest_at FROM status_intervals WHERE ${where}${cutoffClause}`,
      )
      .get(...parameters, ...(options.before ? [options.before] : [])) as Record<string, unknown>;
    return {
      intervalCount: Number(row.interval_count),
      sessionCount: Number(row.session_count),
      ...(row.oldest_at ? { oldestAt: databaseString(row.oldest_at) } : {}),
      ...(row.newest_at ? { newestAt: databaseString(row.newest_at) } : {}),
    };
  }

  purgeHistory(options: PurgeOptions, reason = 'manual'): MaintenanceSummary {
    const startedAt = now();
    const { where, parameters } = this.purgeWhere(options);
    const id = randomUUID();
    let sessionsRemoved = 0;
    let intervalsRemoved = 0;
    this.db.transaction(() => {
      if (options.before) {
        this.db
          .prepare(
            `UPDATE status_intervals SET started_at=? WHERE ${where} AND started_at < ? AND COALESCE(ended_at,last_observation_at) >= ?`,
          )
          .run(options.before, ...parameters, options.before, options.before);
      }
      const deleted = this.db
        .prepare(
          `DELETE FROM status_intervals WHERE ${where} ${options.before ? 'AND COALESCE(ended_at,last_observation_at) < ?' : ''}`,
        )
        .run(...parameters, ...(options.before ? [options.before] : []));
      intervalsRemoved = deleted.changes;
      const removed = this.db
        .prepare(
          `DELETE FROM sessions WHERE ended_at IS NOT NULL AND id NOT IN (SELECT DISTINCT session_id FROM status_intervals)`,
        )
        .run();
      sessionsRemoved = removed.changes;
      if (options.clearLastKnown) this.db.prepare('DELETE FROM check_last_state').run();
    })();
    const endedAt = now();
    this.db
      .prepare(
        `INSERT INTO maintenance_runs(id,started_at,ended_at,reason,cutoff_at,intervals_removed,sessions_removed)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        startedAt,
        endedAt,
        reason,
        options.before ?? null,
        intervalsRemoved,
        sessionsRemoved,
      );
    return {
      id,
      startedAt,
      endedAt,
      reason,
      ...(options.before ? { cutoffAt: options.before } : {}),
      intervalsRemoved,
      sessionsRemoved,
    };
  }

  private purgeWhere(options: PurgeOptions): { where: string; parameters: unknown[] } {
    const clauses = [`session_id IN (SELECT id FROM sessions WHERE ended_at IS NOT NULL)`];
    const parameters: unknown[] = [];
    if (options.sessionIds?.length) {
      clauses.push(`session_id IN (${options.sessionIds.map(() => '?').join(',')})`);
      parameters.push(...options.sessionIds);
    }
    if (options.targetId) {
      const ids = this.getInternalIds(options.targetId, options.checkId);
      clauses.push('target_internal_id=?');
      parameters.push(ids.targetInternalId);
      if (ids.checkInternalId) {
        clauses.push('check_internal_id=?');
        parameters.push(ids.checkInternalId);
      }
    }
    if (!options.all && !options.before && !options.sessionIds?.length && !options.targetId)
      clauses.push('0=1');
    return { where: clauses.join(' AND '), parameters };
  }

  getDatabaseStats(): DatabaseStats {
    const fileSize = (path: string): number => (existsSync(path) ? statSync(path).size : 0);
    const databaseBytes = fileSize(this.databasePath);
    const walBytes = fileSize(`${this.databasePath}-wal`);
    const shmBytes = fileSize(`${this.databasePath}-shm`);
    const counts = this.db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM targets WHERE deleted_at IS NULL) target_count,
      (SELECT COUNT(*) FROM checks WHERE deleted_at IS NULL) check_count,
      (SELECT COUNT(*) FROM sessions) session_count,
      (SELECT COUNT(*) FROM status_intervals) interval_count,
      (SELECT MIN(started_at) FROM status_intervals) oldest_at,
      (SELECT MAX(last_observation_at) FROM status_intervals) newest_at`,
      )
      .get() as Record<string, unknown>;
    const last = this.db
      .prepare('SELECT * FROM maintenance_runs ORDER BY ended_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return {
      databaseBytes,
      walBytes,
      shmBytes,
      totalBytes: databaseBytes + walBytes + shmBytes,
      targetCount: Number(counts.target_count),
      checkCount: Number(counts.check_count),
      sessionCount: Number(counts.session_count),
      intervalCount: Number(counts.interval_count),
      ...(counts.oldest_at ? { oldestHistoryAt: databaseString(counts.oldest_at) } : {}),
      ...(counts.newest_at ? { newestHistoryAt: databaseString(counts.newest_at) } : {}),
      ...(last ? { lastMaintenance: this.mapMaintenance(last) } : {}),
    };
  }

  optimize(fullVacuum = false): MaintenanceSummary {
    const id = randomUUID();
    const startedAt = now();
    let error: string | undefined;
    try {
      this.db.pragma('optimize');
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      if (fullVacuum) this.db.exec('VACUUM');
      else this.db.pragma('incremental_vacuum(1000)');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Optimization failed';
    }
    const endedAt = now();
    this.db
      .prepare(
        `INSERT INTO maintenance_runs(id,started_at,ended_at,reason,intervals_removed,sessions_removed,error) VALUES(?,?,?,?,0,0,?)`,
      )
      .run(id, startedAt, endedAt, fullVacuum ? 'manual-full-vacuum' : 'optimize', error ?? null);
    return {
      id,
      startedAt,
      endedAt,
      reason: fullVacuum ? 'manual-full-vacuum' : 'optimize',
      intervalsRemoved: 0,
      sessionsRemoved: 0,
      ...(error ? { error } : {}),
    };
  }

  removeUnusedDeletedItems(): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM checks WHERE deleted_at IS NOT NULL AND internal_id NOT IN (SELECT check_internal_id FROM status_intervals) AND internal_id NOT IN (SELECT check_internal_id FROM check_last_state)`,
        )
        .run();
      this.db
        .prepare(
          `DELETE FROM targets WHERE deleted_at IS NOT NULL AND internal_id NOT IN (SELECT target_internal_id FROM checks) AND internal_id NOT IN (SELECT target_internal_id FROM status_intervals)`,
        )
        .run();
    })();
  }

  listHistoricalDefinitions(): HistoricalDefinition[] {
    const targets = this.db
      .prepare(
        `SELECT internal_id,config_id,name,host,deleted_at FROM targets
      WHERE deleted_at IS NOT NULL OR internal_id IN (SELECT target_internal_id FROM checks WHERE deleted_at IS NOT NULL)
      ORDER BY lower(name)`,
      )
      .all() as Array<{
      internal_id: string;
      config_id: string;
      name: string;
      host: string;
      deleted_at: string | null;
    }>;
    const checks = this.db.prepare(
      'SELECT config_id,name,type,deleted_at FROM checks WHERE target_internal_id=? ORDER BY lower(name)',
    );
    return targets.map((target) => ({
      targetId: target.config_id,
      name: target.name,
      host: target.host,
      deleted: target.deleted_at !== null,
      checks: (
        checks.all(target.internal_id) as Array<{
          config_id: string;
          name: string;
          type: 'ping' | 'tcp' | 'http';
          deleted_at: string | null;
        }>
      ).map((check) => ({
        checkId: check.config_id,
        name: check.name,
        type: check.type,
        deleted: check.deleted_at !== null,
      })),
    }));
  }

  private mapMaintenance(row: Record<string, unknown>): MaintenanceSummary {
    return {
      id: String(row.id),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      reason: String(row.reason),
      ...(row.cutoff_at ? { cutoffAt: databaseString(row.cutoff_at) } : {}),
      intervalsRemoved: Number(row.intervals_removed),
      sessionsRemoved: Number(row.sessions_removed),
      ...(row.error ? { error: databaseString(row.error) } : {}),
    };
  }
}
