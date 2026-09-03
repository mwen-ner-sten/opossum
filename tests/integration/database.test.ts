import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/main/storage/database';
import { Repositories } from '../../src/main/storage/repositories';
import Database from 'better-sqlite3';
import { migrations } from '../../src/main/storage/migrations';

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
    expect(database.db.prepare('SELECT version FROM schema_version').pluck().get()).toBe(2);
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
