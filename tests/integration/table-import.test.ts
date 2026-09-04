import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckTemplate } from '@core/config';
import { ApplicationService } from '../../src/main/application';
import { DatabaseService } from '../../src/main/storage/database';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'opossum-table-import-'));
  const database = new DatabaseService({
    database: join(directory, 'opossum.db'),
    backups: join(directory, 'backups'),
  });
  const application = new ApplicationService(database);
  cleanups.push(async () => {
    await application.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  return { application, directory };
}

const template: CheckTemplate = {
  id: 'ebo',
  name: 'EBO',
  checks: [
    { id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] },
    {
      id: 'web',
      name: 'Web',
      type: 'http',
      url: 'https://{{host}}:{{vars.web_port}}/',
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

describe('table import through the application service', () => {
  it('opens a CSV as a mappable table with a suggested mapping', async () => {
    const { application, directory } = setup();
    const file = join(directory, 'sites.csv');
    writeFileSync(file, 'Site Name,IP Address,Region,Web Port\nChicago,10.0.0.1,Chicago,443\n');
    const result = await application.importFromFile(file);
    expect(result).toMatchObject({
      kind: 'table',
      format: 'csv',
      rowCount: 1,
      suggestedMapping: {
        columns: { host: 'IP Address', name: 'Site Name', group: 'Region' },
        vars: { web_port: 'Web Port' },
      },
    });
  });

  it('previews, reports skipped rows, and applies targets linked to a template', async () => {
    const { application, directory } = setup();
    application.saveTemplate(template);
    const file = join(directory, 'sites.csv');
    writeFileSync(
      file,
      'Site Name,IP Address,Region,Web Port\nChicago,10.0.0.1,Chicago,443\nDenver,10.0.0.2,West,8443\nBroken,,West,443\n',
    );
    const source = await application.importFromFile(file);
    if (!('kind' in source) || source.kind !== 'table') throw new Error('expected a table');
    const options = {
      filePath: file,
      mapping: { ...source.suggestedMapping, defaults: { template: 'ebo', idPrefix: 'site-' } },
    };
    const preview = await application.previewTableImport(options);
    expect(preview.targets.map((target) => target.id)).toEqual(['site-chicago', 'site-denver']);
    expect(preview.issues).toEqual([{ row: 3, message: 'No host value' }]);
    expect(preview.preview.newTargets).toBe(2);

    const applied = await application.applyTableImport({ ...options, mode: 'add-only' });
    expect(applied.imported).toBe(2);
    const targets = application.repositories.listTargets();
    expect(targets.map((target) => target.id)).toEqual(['site-chicago', 'site-denver']);
    expect(targets[1]?.checks.map((check) => check.id)).toEqual(['ping', 'web']);
    expect(targets[1]?.checks[1]).toMatchObject({
      url: 'https://10.0.0.2:8443/',
      from_template: 'ebo',
    });
    expect(application.scheduler.getStates()).toHaveLength(4);
  });

  it('builds a table from pasted text and refuses to apply when nothing maps', async () => {
    const { application } = setup();
    const source = application.importFromText('name\thost\nA\t10.0.0.9\n');
    expect(source.format).toBe('tsv');
    expect(source.columns).toEqual(['name', 'host']);
    await expect(
      application.applyTableImport({
        text: 'name\thost\nA\t10.0.0.9\n',
        mapping: { columns: { host: 'host' }, defaults: {}, vars: {} },
      }),
    ).rejects.toThrow(/No rows could be turned into targets/);
  });

  it('exports templates and own checks only, and round-trips through YAML import', async () => {
    const { application, directory } = setup();
    application.saveTemplate(template);
    application.saveTarget({
      id: 'a',
      name: 'A',
      host: '10.0.0.1',
      enabled: true,
      template: 'ebo',
      vars: { web_port: '443' },
      checks: [{ id: 'rdp', name: 'RDP', type: 'tcp', port: 3389, enabled: true, tags: [] }],
    });
    const file = join(directory, 'export.yaml');
    application.exportToFile(file);
    const yaml = await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8'));
    expect(yaml).toContain('id: ebo');
    expect(yaml).toContain('template: ebo');
    expect(yaml).not.toContain('from_template');
    expect(yaml).not.toContain('https://10.0.0.1:443/');

    const preview = await application.importFromFile(file);
    expect(preview).toMatchObject({ matchingTargets: 1, matchingTemplates: 1, newTemplates: 0 });
    await application.importFromFile(file, 'replace');
    expect(
      application.repositories
        .listTargets()[0]
        ?.checks.map((check) => check.id)
        .sort(),
    ).toEqual(['ping', 'rdp', 'web']);
  });
});
