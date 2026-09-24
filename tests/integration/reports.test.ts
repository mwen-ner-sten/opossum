import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ApplicationService } from '../../src/main/application';
import { DatabaseService } from '../../src/main/storage/database';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
it('exports only the selected session and retains deleted definitions with their observations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opossum-report-'));
  const db = new DatabaseService({
    database: join(directory, 'opossum.db'),
    backups: join(directory, 'backups'),
  });
  const app = new ApplicationService(db);
  cleanups.push(async () => {
    await app.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  app.saveTarget({
    id: 'site',
    name: 'Deleted site',
    host: 'localhost',
    enabled: true,
    checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
  });
  const sessionId = app.session.id;
  const at = new Date().toISOString();
  app.repositories.recordResult(sessionId, 'site', 'ping', {
    status: 'FAIL',
    category: 'timeout',
    summary: 'Test failure',
    startedAt: at,
    completedAt: at,
    durationMs: 1000,
  });
  app.repositories.closeSession(sessionId);
  const other = app.repositories.createSession('0.1');
  app.repositories.recordResult(other.id, 'site', 'ping', {
    status: 'PASS',
    category: 'success',
    summary: 'Other session only',
    startedAt: at,
    completedAt: at,
    durationMs: 1,
  });
  app.deleteTarget('site');
  const report = app.getSessionReport(sessionId);
  expect(report.csv).toContain('Deleted site');
  expect(report.csv).toContain('Test failure');
  expect(report.csv).not.toContain('Other session only');
  expect(report.summary).toContain('Deleted site (localhost)');
  expect(report.summary).not.toContain('(in progress)');
  expect(() => app.getSessionReport('missing')).toThrow('no longer retained');
});
