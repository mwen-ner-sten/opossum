import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/main/storage/database';
import { Repositories } from '../../src/main/storage/repositories';
import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/storage/migrations';

const directories: string[] = [];
const databases: DatabaseService[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'opossum-test-'));
  directories.push(directory);
  const database = new DatabaseService({
    database: join(directory, 'opossum.db'),
    backups: join(directory, 'backups'),
  });
  databases.push(database);
  return { database, repositories: new Repositories(database.db, database.paths.database) };
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.db.open) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('SQLite repositories', () => {
  it('creates a backup before applying a stored-data migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opossum-test-'));
    directories.push(directory);
    const path = join(directory, 'opossum.db');
    const legacy = new Database(path);
    legacy.exec(migrations[0]!.sql);
    legacy.prepare('UPDATE schema_version SET version=1').run();
    legacy.close();
    const database = new DatabaseService({ database: path, backups: join(directory, 'backups') });
    databases.push(database);
    expect(
      readdirSync(join(directory, 'backups')).filter((name) => name.endsWith('.db')),
    ).toHaveLength(1);
    expect(database.db.prepare('SELECT version FROM schema_version').pluck().get()).toBe(
      LATEST_SCHEMA_VERSION,
    );
    expect(database.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses to open a database written by a newer schema', () => {
    const { database } = setup();
    database.db.prepare('UPDATE schema_version SET version=?').run(LATEST_SCHEMA_VERSION + 5);
    database.close();
    expect(
      () =>
        new DatabaseService({ database: database.paths.database, backups: database.paths.backups }),
    ).toThrow(/newer than this build/);
  });

  it('deletes a closed session even when a check last-known result still points at it', () => {
    const { repositories } = setup();
    repositories.saveTarget({
      id: 'server',
      name: 'Server',
      host: 'localhost',
      enabled: true,
      checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
    });
    const closed = repositories.createSession('test');
    repositories.recordResult(closed.id, 'server', 'ping', {
      status: 'PASS',
      category: 'success',
      summary: 'OK',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1,
    });
    repositories.closeSession(closed.id);
    repositories.createSession('test-2');
    const summary = repositories.purgeHistory({ sessionIds: [closed.id] });
    expect(summary.error).toBeUndefined();
    expect(summary.sessionsRemoved).toBe(1);
    expect(repositories.listSessions().map((session) => session.id)).not.toContain(closed.id);
    const lastKnown = repositories.getLastKnownStates();
    expect(lastKnown).toHaveLength(1);
    expect(lastKnown[0]?.sessionId).toBeUndefined();
    expect(lastKnown[0]?.result.summary).toBe('OK');
  });

  it('only removes empty sessions inside the purge scope', () => {
    const { repositories } = setup();
    const emptyOld = repositories.createSession('a');
    repositories.closeSession(emptyOld.id);
    const emptyRecent = repositories.createSession('b');
    repositories.closeSession(emptyRecent.id);
    repositories.createSession('current');
    const summary = repositories.purgeHistory({ sessionIds: [emptyOld.id] });
    expect(summary.sessionsRemoved).toBe(1);
    expect(repositories.listSessions().map((session) => session.id)).toContain(emptyRecent.id);
  });
  it('creates a WAL database and preserves identity through edits and soft deletion', () => {
    const { database, repositories } = setup();
    expect(database.db.pragma('journal_mode', { simple: true })).toBe('wal');
    repositories.saveTarget({
      id: 'server',
      name: 'Server',
      host: 'localhost',
      enabled: true,
      checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
    });
    const before = repositories.getInternalIds('server', 'ping');
    repositories.saveTarget({
      id: 'server',
      name: 'Renamed',
      host: '127.0.0.1',
      enabled: true,
      checks: [{ id: 'ping', name: 'New ping name', type: 'ping', enabled: true, tags: [] }],
    });
    expect(repositories.getInternalIds('server', 'ping')).toEqual(before);
    repositories.deleteTarget('server');
    expect(repositories.listTargets()).toHaveLength(0);
    expect(repositories.listTargets(true)[0]?.name).toBe('Renamed');
    database.close();
  });

  it('compresses stable observations and transitions diagnostic categories', () => {
    const { database, repositories } = setup();
    repositories.saveTarget({
      id: 'server',
      name: 'Server',
      host: 'localhost',
      enabled: true,
      checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
    });
    const session = repositories.createSession('test');
    repositories.recordSessionStartState(session.id, 'server', 'ping', 'UNKNOWN');
    const result = {
      status: 'PASS' as const,
      category: 'success' as const,
      summary: 'Reply in 1 ms',
      startedAt: '2026-01-01T00:00:01.000Z',
      completedAt: '2026-01-01T00:00:01.001Z',
      durationMs: 1,
    };
    repositories.recordResult(session.id, 'server', 'ping', result);
    repositories.recordResult(session.id, 'server', 'ping', {
      ...result,
      startedAt: '2026-01-01T00:00:02.000Z',
      completedAt: '2026-01-01T00:00:02.002Z',
      durationMs: 2,
    });
    const rows = database.db
      .prepare('SELECT status,observation_count FROM status_intervals ORDER BY rowid')
      .all() as { status: string; observation_count: number }[];
    expect(rows).toEqual([
      { status: 'UNKNOWN', observation_count: 1 },
      { status: 'PASS', observation_count: 2 },
    ]);
    expect(repositories.getLastKnownStates()[0]?.result.durationMs).toBe(2);
    repositories.closeSession(session.id);
    database.close();
  });

  it('recovers an unclean session at its final heartbeat boundary', () => {
    const { database, repositories } = setup();
    const abandoned = repositories.createSession('test');
    database.close();
    const reopened = new DatabaseService({
      database: database.paths.database,
      backups: database.paths.backups,
    });
    databases.push(reopened);
    const recoveredRepositories = new Repositories(reopened.db, reopened.paths.database);
    recoveredRepositories.createSession('test-2');
    const recovered = recoveredRepositories
      .listSessions()
      .find((session) => session.id === abandoned.id);
    expect(recovered).toMatchObject({ cleanShutdown: false });
    expect(recovered?.endedAt).toBeTruthy();
  });

  it('trims cutoff-crossing intervals while preserving configuration and last-known state', () => {
    const { database, repositories } = setup();
    repositories.saveTarget({
      id: 'server',
      name: 'Server',
      host: 'localhost',
      enabled: true,
      checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
    });
    const session = repositories.createSession('test');
    repositories.recordResult(session.id, 'server', 'ping', {
      status: 'PASS',
      category: 'success',
      summary: 'OK',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-03T00:00:00.000Z',
      durationMs: 1,
    });
    repositories.closeSession(session.id);
    database.db
      .prepare(
        "UPDATE status_intervals SET started_at='2026-01-01T00:00:00.000Z', ended_at='2026-01-03T00:00:00.000Z', last_observation_at='2026-01-03T00:00:00.000Z'",
      )
      .run();
    repositories.purgeHistory({ before: '2026-01-02T00:00:00.000Z' });
    const row = database.db.prepare('SELECT started_at FROM status_intervals').get() as {
      started_at: string;
    };
    expect(row.started_at).toBe('2026-01-02T00:00:00.000Z');
    expect(repositories.listTargets()).toHaveLength(1);
    expect(repositories.getLastKnownStates()).toHaveLength(1);
    database.close();
  });
});
