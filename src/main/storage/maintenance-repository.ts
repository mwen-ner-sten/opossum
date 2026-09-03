import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  DatabaseStats,
  MaintenanceSummary,
  PurgeOptions,
  PurgePreview,
} from '@shared/contracts';
import { databaseString, now, placeholders, type Db, type Row } from './sql';
import type { TargetRepository } from './target-repository';

const BATCH = 1_000;
/** Bounded history of maintenance summaries kept in the database. */
export const MAINTENANCE_RUNS_KEPT = 200;

export class MaintenanceRepository {
  constructor(
    private readonly db: Db,
    private readonly databasePath: string,
    private readonly targets: TargetRepository,
  ) {}

  previewPurge(options: PurgeOptions): PurgePreview {
    const { where, parameters } = this.purgeWhere(options);
    const cutoffClause = options.before ? ' AND started_at < ?' : '';
    const row = this.db
      .prepare(
        `SELECT COUNT(*) interval_count, COUNT(DISTINCT session_id) session_count,
      MIN(started_at) oldest_at, MAX(last_observation_at) newest_at FROM status_intervals WHERE ${where}${cutoffClause}`,
      )
      .get(...parameters, ...(options.before ? [options.before] : [])) as Row;
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
    let intervalsTrimmed = 0;
    let error: string | undefined;
    try {
      if (options.before)
        intervalsTrimmed = this.trimCrossingIntervals(where, parameters, options.before);
      intervalsRemoved = this.deleteIntervals(where, parameters, options.before);
      this.db.transaction(() => {
        sessionsRemoved = this.deleteEmptySessions(options);
        if (options.clearLastKnown) this.db.prepare('DELETE FROM check_last_state').run();
      })();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'History purge failed';
    }
    return this.recordRun(
      {
        id,
        startedAt,
        endedAt: now(),
        reason,
        ...(options.before ? { cutoffAt: options.before } : {}),
        intervalsRemoved,
        sessionsRemoved,
        ...(error ? { error } : {}),
      },
      { intervalsTrimmed },
    );
  }

  /** Intervals straddling the cutoff keep their post-cutoff portion. */
  private trimCrossingIntervals(where: string, parameters: unknown[], before: string): number {
    let trimmed = 0;
    while (true) {
      const crossing = this.db
        .prepare(
          `SELECT id FROM status_intervals WHERE ${where} AND started_at < ?
           AND COALESCE(ended_at,last_observation_at) >= ? LIMIT ${BATCH}`,
        )
        .all(...parameters, before, before) as Array<{ id: string }>;
      if (crossing.length === 0) return trimmed;
      this.db.transaction(() => {
        trimmed += this.db
          .prepare(
            `UPDATE status_intervals SET started_at=? WHERE id IN (${placeholders(crossing.length)})`,
          )
          .run(before, ...crossing.map((row) => row.id)).changes;
      })();
    }
  }

  private deleteIntervals(where: string, parameters: unknown[], before?: string): number {
    let removed = 0;
    while (true) {
      const rows = this.db
        .prepare(
          `SELECT id FROM status_intervals WHERE ${where}
           ${before ? 'AND COALESCE(ended_at,last_observation_at) < ?' : ''} LIMIT ${BATCH}`,
        )
        .all(...parameters, ...(before ? [before] : [])) as Array<{ id: string }>;
      if (rows.length === 0) return removed;
      this.db.transaction(() => {
        removed += this.db
          .prepare(`DELETE FROM status_intervals WHERE id IN (${placeholders(rows.length)})`)
          .run(...rows.map((row) => row.id)).changes;
      })();
    }
  }

  /**
   * Removes closed sessions left without intervals, limited to the sessions this purge could
   * have emptied so that `sessionsRemoved` reflects the requested scope.
   */
  private deleteEmptySessions(options: PurgeOptions): number {
    const scope: string[] = [
      'ended_at IS NOT NULL',
      'id NOT IN (SELECT DISTINCT session_id FROM status_intervals)',
    ];
    const parameters: unknown[] = [];
    if (options.sessionIds?.length) {
      scope.push(`id IN (${placeholders(options.sessionIds.length)})`);
      parameters.push(...options.sessionIds);
    } else if (options.before) {
      scope.push('started_at < ?');
      parameters.push(options.before);
    }
    return this.db.prepare(`DELETE FROM sessions WHERE ${scope.join(' AND ')}`).run(...parameters)
      .changes;
  }

  private purgeWhere(options: PurgeOptions): { where: string; parameters: unknown[] } {
    const clauses = [`session_id IN (SELECT id FROM sessions WHERE ended_at IS NOT NULL)`];
    const parameters: unknown[] = [];
    if (options.sessionIds?.length) {
      clauses.push(`session_id IN (${placeholders(options.sessionIds.length)})`);
      parameters.push(...options.sessionIds);
    }
    if (options.targetId) {
      const ids = this.targets.internalIds(options.targetId, options.checkId);
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

  databaseStats(): DatabaseStats {
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
      .get() as Row;
    const last = this.db
      .prepare('SELECT * FROM maintenance_runs ORDER BY ended_at DESC LIMIT 1')
      .get() as Row | undefined;
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
      ...(last ? { lastMaintenance: MaintenanceRepository.map(last) } : {}),
    };
  }

  optimize(fullVacuum = false): MaintenanceSummary {
    const startedAt = now();
    let error: string | undefined;
    try {
      this.db.pragma('optimize');
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      if (fullVacuum) this.db.exec('VACUUM');
      else this.db.pragma(`incremental_vacuum(${BATCH})`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Optimization failed';
    }
    return this.recordRun({
      id: randomUUID(),
      startedAt,
      endedAt: now(),
      reason: fullVacuum ? 'manual-full-vacuum' : 'optimize',
      intervalsRemoved: 0,
      sessionsRemoved: 0,
      ...(error ? { error } : {}),
    });
  }

  private recordRun(summary: MaintenanceSummary, details?: Row): MaintenanceSummary {
    this.db
      .prepare(
        `INSERT INTO maintenance_runs(id,started_at,ended_at,reason,cutoff_at,intervals_removed,sessions_removed,error,details_json)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        summary.id,
        summary.startedAt,
        summary.endedAt,
        summary.reason,
        summary.cutoffAt ?? null,
        summary.intervalsRemoved,
        summary.sessionsRemoved,
        summary.error ?? null,
        details ? JSON.stringify(details) : null,
      );
    this.db
      .prepare(
        `DELETE FROM maintenance_runs WHERE id NOT IN (SELECT id FROM maintenance_runs ORDER BY ended_at DESC LIMIT ?)`,
      )
      .run(MAINTENANCE_RUNS_KEPT);
    return summary;
  }

  private static map(row: Row): MaintenanceSummary {
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
