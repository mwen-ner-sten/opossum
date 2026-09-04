import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type TargetConfig } from '@core/config';
import type { CheckResult } from '@core/models';
import { DatabaseService } from '../../src/main/storage/database';
import { Repositories } from '../../src/main/storage/repositories';

const directories: string[] = [];
const databases: DatabaseService[] = [];
function setup(onWarning?: (message: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'opossum-repo-'));
  directories.push(directory);
  const database = new DatabaseService({
    database: join(directory, 'opossum.db'),
    backups: join(directory, 'backups'),
  });
  databases.push(database);
  return {
    database,
    repositories: new Repositories(database.db, database.paths.database, onWarning),
  };
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.db.open) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const target = (id: string, checks: TargetConfig['checks']): TargetConfig => ({
  id,
  name: id.toUpperCase(),
  host: 'localhost',
  enabled: true,
  checks,
});
const ping = (id = 'ping'): TargetConfig['checks'][number] => ({
  id,
  name: `Ping ${id}`,
  type: 'ping',
  enabled: true,
  tags: [],
});
const pass = (iso: string): CheckResult => ({
  status: 'PASS',
  category: 'success',
  summary: 'OK',
  startedAt: iso,
  completedAt: iso,
  durationMs: 3,
});

describe('configuration import modes', () => {
  it('replace mode upserts, restores soft-deleted identities, and soft-deletes absent targets', () => {
    const { repositories } = setup();
    repositories.saveTarget(target('a', [ping()]));
    repositories.saveTarget(target('b', [ping()]));
    repositories.saveTarget(target('c', [ping()]));
    repositories.deleteTarget('c');
    const before = repositories.getInternalIds('a', 'ping');
    repositories.replaceActiveConfiguration({ ...DEFAULT_SETTINGS, default_interval_seconds: 45 }, [
      target('a', [ping(), ping('tcp-ish')]),
      target('c', [ping()]),
    ]);
    const active = repositories.listTargets().map((item) => item.id);
    expect(active).toEqual(['a', 'c']);
    expect(repositories.getInternalIds('a', 'ping')).toEqual(before);
    expect(repositories.getSettings().default_interval_seconds).toBe(45);
    expect(repositories.listTargets(true).map((item) => item.id)).toContain('b');
    expect(repositories.listTargets().find((item) => item.id === 'a')?.checks).toHaveLength(2);
  });

  it('replace mode with an empty file soft-deletes everything', () => {
    const { repositories } = setup();
    repositories.saveTarget(target('a', [ping()]));
    repositories.replaceActiveConfiguration(DEFAULT_SETTINGS, []);
    expect(repositories.listTargets()).toEqual([]);
    expect(repositories.listTargets(true)).toHaveLength(1);
  });

  it('add-only mode never touches existing or deleted identities', () => {
    const { repositories } = setup();
    repositories.saveTarget(target('a', [ping()]));
    repositories.saveTarget(target('gone', [ping()]));
    repositories.deleteTarget('gone');
    repositories.addOnlyTargets([
      { ...target('a', [ping()]), name: 'RENAMED' },
      target('gone', [ping()]),
      target('new', [ping()]),
    ]);
    const byId = new Map(repositories.listTargets().map((item) => [item.id, item]));
    expect(byId.get('a')?.name).toBe('A');
    expect(byId.has('gone')).toBe(false);
    expect(byId.has('new')).toBe(true);
  });
});

describe('check editing', () => {
  it('renames a check in place, rejects ID collisions, and soft-deletes single checks', () => {
    const { repositories } = setup();
    repositories.saveTarget(target('a', [ping('one'), ping('two')]));
    const before = repositories.getInternalIds('a', 'one');
    repositories.saveCheck('a', ping('renamed'), 'one');
    expect(repositories.getInternalIds('a', 'renamed')).toEqual(before);
    expect(() => repositories.saveCheck('a', ping('two'), 'renamed')).toThrow(/already exists/);
    repositories.deleteCheck('a', 'two');
    expect(repositories.listTargets()[0]?.checks.map((check) => check.id)).toEqual(['renamed']);
    expect(() => repositories.getInternalIds('a', 'missing')).toThrow(/not found/);
    expect(() => repositories.getInternalIds('nope')).toThrow(/not found/);
  });

  it('lists deleted definitions and removes only those without history', () => {
    const { repositories } = setup();
    repositories.saveTarget(target('kept', [ping()]));
    repositories.saveTarget(target('unused', [ping()]));
    const session = repositories.createSession('t');
    repositories.recordResult(session.id, 'kept', 'ping', pass('2026-01-01T00:00:00.000Z'));
    repositories.deleteTarget('kept');
    repositories.deleteTarget('unused');
    expect(repositories.listHistoricalDefinitions().map((item) => item.targetId)).toEqual([
      'kept',
      'unused',
    ]);
    repositories.removeUnusedDeletedItems();
    expect(repositories.listHistoricalDefinitions().map((item) => item.targetId)).toEqual(['kept']);
  });

  it('skips a stored check whose configuration no longer validates instead of failing startup', () => {
    const warnings: string[] = [];
    const { database, repositories } = setup((message) => warnings.push(message));
    repositories.saveTarget(target('a', [ping('good'), ping('bad')]));
    database.db
      .prepare(`UPDATE checks SET config_json='{"id":"bad","type":"nope"}' WHERE config_id='bad'`)
      .run();
    expect(repositories.listTargets()[0]?.checks.map((check) => check.id)).toEqual(['good']);
    expect(warnings[0]).toContain('a/bad');
  });
});

describe('sessions and timelines', () => {
  it('pages sessions, resolves previous session, and aggregates a target timeline', () => {
    const { repositories } = setup();
    repositories.saveTarget(target('a', [ping('one'), ping('two')]));
    const first = repositories.createSession('t');
    repositories.recordResult(first.id, 'a', 'one', pass('2026-01-01T00:00:00.000Z'));
    repositories.recordResult(first.id, 'a', 'two', {
      ...pass('2026-01-01T00:00:00.000Z'),
      status: 'FAIL',
      category: 'timeout',
    });
    repositories.closeSession(first.id);
    const current = repositories.createSession('t');
    expect(repositories.sessions.latestOther(current.id)?.id).toBe(first.id);
    expect(repositories.sessions.get(first.id)).toMatchObject({
      cleanShutdown: true,
      failCount: 1,
    });
    expect(repositories.sessions.get('missing')).toBeUndefined();
    expect(repositories.sessions.oldestStart()).toBe(first.startedAt);
    expect(repositories.listSessions(10, current.startedAt).map((s) => s.id)).toEqual([first.id]);
    const segments = repositories.getTimeline(
      'a',
      undefined,
      '2025-12-31T00:00:00.000Z',
      new Date().toISOString(),
    );
    expect(segments.map((segment) => segment.status)).toContain('FAIL');
    expect(segments.every((segment) => segment.sessionId)).toBe(true);
  });

  it('previews and purges by target scope and clears last-known state on request', () => {
    const { repositories } = setup();
    repositories.saveTarget(target('a', [ping()]));
    repositories.saveTarget(target('b', [ping()]));
    const closed = repositories.createSession('t');
    repositories.recordResult(closed.id, 'a', 'ping', pass('2026-01-01T00:00:00.000Z'));
    repositories.recordResult(closed.id, 'b', 'ping', pass('2026-01-01T00:00:00.000Z'));
    repositories.closeSession(closed.id);
    repositories.createSession('current');
    expect(repositories.previewPurge({ targetId: 'a', checkId: 'ping' }).intervalCount).toBe(1);
    expect(repositories.previewPurge({}).intervalCount).toBe(0);
    const scoped = repositories.purgeHistory({ targetId: 'a' });
    expect(scoped).toMatchObject({ intervalsRemoved: 1, sessionsRemoved: 0 });
    const all = repositories.purgeHistory({ all: true, clearLastKnown: true });
    expect(all.intervalsRemoved).toBe(1);
    expect(repositories.getLastKnownStates()).toEqual([]);
    const stats = repositories.getDatabaseStats();
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.lastMaintenance?.reason).toBe('manual');
    expect(repositories.optimize(true).error).toBeUndefined();
  });
});
