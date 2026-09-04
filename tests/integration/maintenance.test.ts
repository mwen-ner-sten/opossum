import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/config';
import type { CheckResult } from '@core/models';
import type { MaintenanceSummary } from '@shared/contracts';
import { DatabaseService } from '../../src/main/storage/database';
import { MaintenanceEngine } from '../../src/main/storage/maintenance';
import { MAINTENANCE_RUNS_KEPT } from '../../src/main/storage/maintenance-repository';
import { Repositories } from '../../src/main/storage/repositories';

const directories: string[] = [];
const databases: DatabaseService[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'opossum-maint-'));
  directories.push(directory);
  const database = new DatabaseService({
    database: join(directory, 'opossum.db'),
    backups: join(directory, 'backups'),
  });
  databases.push(database);
  const repositories = new Repositories(database.db, database.paths.database);
  repositories.saveTarget({
    id: 'server',
    name: 'Server',
    host: 'localhost',
    enabled: true,
    checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
  });
  return { database, repositories };
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.db.open) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const at = (iso: string): CheckResult => ({
  status: 'PASS',
  category: 'success',
  summary: 'OK',
  startedAt: iso,
  completedAt: iso,
  durationMs: 1,
});

/** Creates a closed session dated `daysAgo` holding `count` intervals from that time. */
function closedSession(
  database: DatabaseService,
  repositories: Repositories,
  daysAgo: number,
  count = 1,
): string {
  const session = repositories.createSession('t');
  const startedAt = new Date(Date.now() - daysAgo * 86_400_000);
  for (let index = 0; index < count; index += 1) {
    const stamp = new Date(startedAt.getTime() + index * 60_000).toISOString();
    repositories.recordResult(session.id, 'server', 'ping', {
      ...at(stamp),
      category: index % 2 === 0 ? 'success' : 'timeout',
      status: index % 2 === 0 ? 'PASS' : 'FAIL',
    });
  }
  repositories.closeSession(session.id);
  const endedAt = new Date(startedAt.getTime() + count * 60_000).toISOString();
  database.db
    .prepare('UPDATE sessions SET started_at=?, ended_at=?, last_heartbeat_at=? WHERE id=?')
    .run(startedAt.toISOString(), endedAt, endedAt, session.id);
  database.db
    .prepare('UPDATE status_intervals SET ended_at=? WHERE session_id=? AND ended_at > ?')
    .run(endedAt, session.id, endedAt);
  return session.id;
}

describe('maintenance engine', () => {
  it('purges history older than the age limit and reports only runs that changed something', async () => {
    const { database, repositories } = setup();
    const old = closedSession(database, repositories, 400, 4);
    const recent = closedSession(database, repositories, 2, 4);
    repositories.createSession('current');
    const completed: MaintenanceSummary[] = [];
    const engine = new MaintenanceEngine(repositories, (summary) => completed.push(summary));
    await engine.runBounded({ ...DEFAULT_SETTINGS, history_max_age_days: 180 });
    const ids = repositories.listSessions().map((session) => session.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(recent);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ reason: 'automatic-age', sessionsRemoved: 1 });

    completed.length = 0;
    await engine.runBounded({ ...DEFAULT_SETTINGS, history_max_age_days: 180 });
    expect(completed).toEqual([]); // nothing left to remove, so no toast-worthy summary
  });

  it('removes oldest closed sessions until the size guard is satisfied and never touches the current session', async () => {
    const { database, repositories } = setup();
    const first = closedSession(database, repositories, 30, 40);
    const second = closedSession(database, repositories, 20, 40);
    const current = repositories.createSession('current');
    repositories.recordResult(current.id, 'server', 'ping', at(new Date().toISOString()));
    const errors: unknown[] = [];
    const engine = new MaintenanceEngine(
      repositories,
      () => undefined,
      (error) => errors.push(error),
    );
    // A guard far below the minimum SQLite file size forces the size loop to run to exhaustion.
    await engine.runBounded({
      ...DEFAULT_SETTINGS,
      history_max_age_days: 0,
      history_max_database_mb: 0.001,
    });
    const remaining = repositories.listSessions().map((session) => session.id);
    expect(remaining).not.toContain(first);
    expect(remaining).not.toContain(second);
    expect(remaining).toContain(current.id);
    expect(repositories.getDatabaseStats().intervalCount).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('skips work while disabled and defers startup maintenance', async () => {
    const { database, repositories } = setup();
    closedSession(database, repositories, 400);
    repositories.createSession('current');
    const completed: MaintenanceSummary[] = [];
    const engine = new MaintenanceEngine(repositories, (summary) => completed.push(summary));
    await engine.runBounded({
      ...DEFAULT_SETTINGS,
      history_max_age_days: 0,
      history_max_database_mb: 0,
    });
    expect(completed).toEqual([]);
    expect(repositories.listSessions()).toHaveLength(2);

    engine.start({ ...DEFAULT_SETTINGS, maintenance_on_startup: true });
    expect(completed).toEqual([]); // not yet: startup maintenance waits for the first checks
    engine.stop();
  });

  it('keeps the maintenance log bounded', () => {
    const { repositories } = setup();
    for (let index = 0; index < MAINTENANCE_RUNS_KEPT + 25; index += 1)
      repositories.optimize(false);
    const count = repositories.getDatabaseStats();
    expect(count.lastMaintenance?.reason).toBe('optimize');
    const rows = repositories.maintenance.databaseStats();
    expect(rows).toBeDefined();
    const total = (
      repositories as unknown as { db: { prepare(sql: string): { pluck(): { get(): number } } } }
    ).db
      .prepare('SELECT COUNT(*) FROM maintenance_runs')
      .pluck()
      .get();
    expect(total).toBe(MAINTENANCE_RUNS_KEPT);
  });
});
