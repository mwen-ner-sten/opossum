import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckTemplate, TargetConfig } from '@core/config';
import { DatabaseService } from '../../src/main/storage/database';
import { Repositories } from '../../src/main/storage/repositories';

const directories: string[] = [];
const databases: DatabaseService[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'opossum-templates-'));
  directories.push(directory);
  const database = new DatabaseService({
    database: join(directory, 'opossum.db'),
    backups: join(directory, 'backups'),
  });
  databases.push(database);
  return new Repositories(database.db, database.paths.database);
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.db.open) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const ebo: CheckTemplate = {
  id: 'ebo',
  name: 'EBO server',
  checks: [
    { id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] },
    {
      id: 'web',
      name: 'Web',
      type: 'http',
      url: 'https://{{host}}/',
      method: 'GET',
      expected_status: '200-399',
      headers: {},
      verify_tls: false,
      follow_redirects: true,
      enabled: true,
      tags: [],
    },
  ],
};
const web = ebo.checks[1] as Extract<CheckTemplate['checks'][number], { type: 'http' }>;
const site = (id: string, host: string, extra: Partial<TargetConfig> = {}): TargetConfig => ({
  id,
  name: id,
  host,
  enabled: true,
  template: 'ebo',
  checks: [],
  ...extra,
});

describe('templates in storage', () => {
  it('materializes inherited checks per host and marks them as inherited', () => {
    const repositories = setup();
    repositories.saveTemplate(ebo);
    repositories.saveTarget(site('a', '10.0.0.1'));
    repositories.saveTarget(site('b', '10.0.0.2'));
    const [a, b] = repositories.listTargets();
    expect(a?.template).toBe('ebo');
    expect(a?.checks.map((check) => check.id)).toEqual(['ping', 'web']);
    expect(a?.checks[1]).toMatchObject({ url: 'https://10.0.0.1/', from_template: 'ebo' });
    expect(b?.checks[1]).toMatchObject({ url: 'https://10.0.0.2/' });
    expect(repositories.getInternalIds('a', 'web').checkInternalId).toBeDefined();
  });

  it('regenerates linked targets when the template changes and keeps check identity', () => {
    const repositories = setup();
    repositories.saveTemplate(ebo);
    repositories.saveTarget(site('a', '10.0.0.1'));
    const before = repositories.getInternalIds('a', 'web').checkInternalId;
    const updated = repositories.saveTemplate({
      ...ebo,
      checks: [{ ...web, url: 'https://{{host}}:8443/' }],
    });
    expect(updated).toBe(1);
    const target = repositories.listTargets()[0]!;
    expect(target.checks.map((check) => check.id)).toEqual(['web']);
    expect(target.checks[0]).toMatchObject({ url: 'https://10.0.0.1:8443/' });
    expect(repositories.getInternalIds('a', 'web').checkInternalId).toBe(before);
    expect(repositories.listTargets(true)[0]?.checks.map((check) => check.id)).toContain('ping');
  });

  it('keeps own checks alongside inherited ones and lets an own check override', () => {
    const repositories = setup();
    repositories.saveTemplate(ebo);
    repositories.saveTarget(
      site('a', '10.0.0.1', {
        checks: [{ id: 'web', name: 'Custom', type: 'tcp', port: 80, enabled: true, tags: [] }],
      }),
    );
    const target = repositories.listTargets()[0]!;
    expect(target.checks.find((check) => check.id === 'web')).toMatchObject({ type: 'tcp' });
    expect(target.checks.find((check) => check.id === 'web')?.from_template).toBeUndefined();
    expect(target.checks.find((check) => check.id === 'ping')?.from_template).toBe('ebo');
    // Saving the effective list back (as the editor does) must not turn inherited checks into own ones.
    repositories.saveTarget(target);
    expect(
      repositories.listTargets()[0]?.checks.find((check) => check.id === 'ping')?.from_template,
    ).toBe('ebo');
  });

  it('substitutes per-target variables and rejects unknown templates', () => {
    const repositories = setup();
    repositories.saveTemplate({
      ...ebo,
      checks: [{ ...web, url: 'https://{{host}}:{{vars.port}}/' }],
    });
    repositories.saveTarget(site('a', '10.0.0.1', { vars: { port: '9443' } }));
    expect(repositories.listTargets()[0]?.checks[0]).toMatchObject({
      url: 'https://10.0.0.1:9443/',
    });
    // Without the variable the target still saves; the check that needs it is simply absent.
    repositories.saveTarget(site('b', '10.0.0.2'));
    expect(repositories.listTargets().find((target) => target.id === 'b')?.checks).toEqual([]);
    repositories.saveTarget(site('b', '10.0.0.2', { vars: { port: '80' } }));
    expect(repositories.listTargets().find((target) => target.id === 'b')?.checks[0]).toMatchObject(
      { url: 'https://10.0.0.2:80/' },
    );
    expect(() => repositories.saveTarget(site('c', '10.0.0.3', { template: 'nope' }))).toThrow(
      /not found/,
    );
  });

  it('refuses to delete a template that targets still use', () => {
    const repositories = setup();
    repositories.saveTemplate(ebo);
    repositories.saveTarget(site('a', '10.0.0.1'));
    expect(() => repositories.deleteTemplate('ebo')).toThrow(/used by 1 target/);
    repositories.deleteTarget('a');
    repositories.deleteTemplate('ebo');
    expect(repositories.listTemplates()).toEqual([]);
  });

  it('imports templates with targets in both modes', () => {
    const repositories = setup();
    repositories.addOnlyTargets([site('a', '10.0.0.1')], [ebo]);
    expect(repositories.listTargets()[0]?.checks).toHaveLength(2);
    repositories.replaceActiveConfiguration(
      undefined,
      [site('b', '10.0.0.2')],
      [{ ...ebo, checks: [ebo.checks[0]!] }],
    );
    expect(repositories.listTargets().map((target) => target.id)).toEqual(['b']);
    expect(repositories.listTargets()[0]?.checks).toHaveLength(1);
  });
});
