import { randomUUID } from 'node:crypto';
import type { CheckResult, LastKnownState, TimelineSegment } from '@core/models';
import { OpossumError } from '@shared/errors';
import { databaseString, now, type Db, type Row } from './sql';
import type { TargetRepository } from './target-repository';

/** Compressed status intervals plus each check's last-known result. */
export class HistoryRepository {
  constructor(
    private readonly db: Db,
    private readonly targets: TargetRepository,
  ) {}

  lastKnownStates(): LastKnownState[] {
    const rows = this.db
      .prepare(
        `SELECT t.config_id target_id, c.config_id check_id, l.*
      FROM check_last_state l JOIN targets t ON t.internal_id=l.target_internal_id JOIN checks c ON c.internal_id=l.check_internal_id
      WHERE t.deleted_at IS NULL AND c.deleted_at IS NULL`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      targetId: String(row.target_id),
      checkId: String(row.check_id),
      ...(row.session_id ? { sessionId: databaseString(row.session_id) } : {}),
      result: {
        status: row.status as 'PASS' | 'FAIL',
        category: row.diagnostic_category as CheckResult['category'],
        summary: String(row.summary),
        startedAt: String(row.started_at),
        completedAt: String(row.completed_at),
        durationMs: Number(row.duration_ms),
        ...(row.details_json
          ? {
              details: JSON.parse(databaseString(row.details_json)) as NonNullable<
                CheckResult['details']
              >,
            }
          : {}),
      },
    }));
  }

  recordResult(sessionId: string, targetId: string, checkId: string, result: CheckResult): void {
    const { targetInternalId, checkInternalId } = this.targets.internalIds(targetId, checkId);
    if (!checkInternalId) throw new OpossumError('NOT_FOUND', 'Check identity is missing.');
    this.db.transaction(() => {
      const active = this.db
        .prepare(
          `SELECT * FROM status_intervals WHERE session_id=? AND check_internal_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        )
        .get(sessionId, checkInternalId) as Row | undefined;
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
            .run(result.completedAt, active.id);
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
            result.completedAt,
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
    const { targetInternalId, checkInternalId } = this.targets.internalIds(targetId, checkId);
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
    const { targetInternalId, checkInternalId } = this.targets.internalIds(targetId, checkId);
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
        return;
      }
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
    })();
  }

  timeline(
    targetId: string,
    checkId: string | undefined,
    startAt: string,
    endAt: string,
  ): TimelineSegment[] {
    const ids = this.targets.internalIds(targetId, checkId);
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
      ) as Row[];
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
}
