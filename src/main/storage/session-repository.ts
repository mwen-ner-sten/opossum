import { randomUUID } from 'node:crypto';
import type { SessionSummary } from '@core/models';
import { databaseString, now, type Db, type Row } from './sql';

/** How far past its final heartbeat an unclean session is assumed to have kept monitoring. */
export const HEARTBEAT_GRACE_MS = 30_000;

export class SessionRepository {
  constructor(private readonly db: Db) {}

  create(applicationVersion: string): SessionSummary {
    const timestamp = now();
    const id = randomUUID();
    this.db.transaction(() => {
      const abandoned = this.db
        .prepare('SELECT id,last_heartbeat_at FROM sessions WHERE ended_at IS NULL')
        .all() as { id: string; last_heartbeat_at: string }[];
      for (const previous of abandoned) {
        const inferred = new Date(
          new Date(previous.last_heartbeat_at).getTime() + HEARTBEAT_GRACE_MS,
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

  close(sessionId: string): void {
    const timestamp = now();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE status_intervals SET ended_at=? WHERE session_id=? AND ended_at IS NULL')
        .run(timestamp, sessionId);
      this.db
        .prepare('UPDATE sessions SET ended_at=?, last_heartbeat_at=?, clean_shutdown=1 WHERE id=?')
        .run(timestamp, timestamp, sessionId);
    })();
  }

  private static readonly SUMMARY_SQL = `SELECT s.*,
      SUM(CASE WHEN i.status='PASS' THEN 1 ELSE 0 END) pass_count,
      SUM(CASE WHEN i.status='FAIL' THEN 1 ELSE 0 END) fail_count
      FROM sessions s LEFT JOIN status_intervals i ON i.session_id=s.id`;

  list(limit = 100, before?: string): SessionSummary[] {
    const rows = this.db
      .prepare(
        `${SessionRepository.SUMMARY_SQL} ${before ? 'WHERE s.started_at < ?' : ''}
         GROUP BY s.id ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(...(before ? [before] : []), limit) as Row[];
    return rows.map(SessionRepository.map);
  }

  get(sessionId: string): SessionSummary | undefined {
    const row = this.db
      .prepare(`${SessionRepository.SUMMARY_SQL} WHERE s.id=? GROUP BY s.id`)
      .get(sessionId) as Row | undefined;
    return row ? SessionRepository.map(row) : undefined;
  }

  /** The most recent session other than `excludeId`, typically the "previous session". */
  latestOther(excludeId: string): SessionSummary | undefined {
    const row = this.db
      .prepare(
        `${SessionRepository.SUMMARY_SQL} WHERE s.id != ? GROUP BY s.id ORDER BY s.started_at DESC LIMIT 1`,
      )
      .get(excludeId) as Row | undefined;
    return row ? SessionRepository.map(row) : undefined;
  }

  oldestStart(): string | undefined {
    const row = this.db.prepare('SELECT MIN(started_at) started_at FROM sessions').get() as {
      started_at: string | null;
    };
    return row.started_at ?? undefined;
  }

  oldestClosedId(): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at LIMIT 1')
      .get() as { id: string } | undefined;
    return row?.id;
  }

  private static map(row: Row): SessionSummary {
    const clean = Boolean(row.clean_shutdown);
    const lastHeartbeatAt = String(row.last_heartbeat_at);
    const inferred =
      !clean && row.ended_at === null
        ? new Date(new Date(lastHeartbeatAt).getTime() + HEARTBEAT_GRACE_MS).toISOString()
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
  }
}
