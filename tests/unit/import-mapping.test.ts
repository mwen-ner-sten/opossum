import { describe, expect, it } from 'vitest';
import type { CheckTemplate } from '@core/config';
import { autoDetectMapping, buildTargetsFromRows, slugify } from '@core/import-mapping';

const template: CheckTemplate = {
  id: 'ebo',
  name: 'EBO',
  checks: [{ id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] }],
};

describe('autoDetectMapping', () => {
  it('recognises common column headings and leaves the rest as variables', () => {
    const mapping = autoDetectMapping([
      'Site Name',
      'IP Address',
      'Region',
      'Template',
      'Web Port',
    ]);
    expect(mapping.columns).toEqual({
      host: 'IP Address',
      name: 'Site Name',
      group: 'Region',
      template: 'Template',
    });
    expect(mapping.vars).toEqual({ web_port: 'Web Port' });
  });
});

describe('slugify', () => {
  it('produces identifier-safe lower-case slugs', () => {
    expect(slugify('Chicago BMS Server 01')).toBe('chicago-bms-server-01');
    expect(slugify('  Ünïcode / Thing!')).toBe('unicode-thing');
  });
});

describe('buildTargetsFromRows', () => {
  const mapping = {
    columns: { host: 'ip', name: 'site', group: 'region' },
    defaults: { template: 'ebo', idPrefix: 'site-' },
    vars: { port: 'port' },
  };
  it('creates one target per row with generated ids and variables', () => {
    const { targets, issues } = buildTargetsFromRows(
      [
        { ip: '10.0.0.1', site: 'Chicago 01', region: 'Chicago', port: '443' },
        { ip: '10.0.0.2', site: 'Chicago 01', region: 'Chicago', port: '' },
      ],
      mapping,
      [template],
    );
    expect(issues).toEqual([]);
    expect(targets.map((target) => target.id)).toEqual(['site-chicago-01', 'site-chicago-01-2']);
    expect(targets[0]).toMatchObject({ template: 'ebo', group: 'Chicago', vars: { port: '443' } });
    expect(targets[1]?.vars).toBeUndefined();
  });
  it('reports rows that cannot become targets without aborting the rest', () => {
    const { targets, issues } = buildTargetsFromRows(
      [
        { ip: '', site: 'Blank' },
        { ip: 'bad host!', site: 'Invalid' },
        { ip: '10.0.0.3', site: 'Other', template: 'nope' },
        { ip: '10.0.0.4', site: 'Good', enabled: 'no' },
      ],
      { ...mapping, columns: { ...mapping.columns, template: 'template', enabled: 'enabled' } },
      [template],
    );
    expect(issues.map((issue) => issue.row)).toEqual([1, 2, 3]);
    expect(issues[1]?.message).toMatch(/host/);
    expect(issues[2]?.message).toMatch(/Unknown template/);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: 'site-good', enabled: false });
  });
  it('refuses rows without any template because they would have no checks', () => {
    const { issues } = buildTargetsFromRows([{ ip: '10.0.0.9' }], { ...mapping, defaults: {} }, []);
    expect(issues[0]?.message).toMatch(/No template/);
  });
});

describe('template variables during import', () => {
  const needsPort: CheckTemplate = {
    id: 'web',
    name: 'Web',
    checks: [
      {
        id: 'web',
        name: 'Web',
        type: 'http',
        url: 'https://{{host}}:{{vars.web_port}}/',
        method: 'GET',
        expected_status: '200-399',
        headers: {},
        verify_tls: true,
        follow_redirects: true,
        enabled: true,
        tags: [],
      },
    ],
  };
  it('reports rows whose template variables are not supplied instead of throwing', () => {
    const { targets, issues } = buildTargetsFromRows(
      [
        { host: '10.0.0.1', port: '443' },
        { host: '10.0.0.2', port: '' },
      ],
      { columns: { host: 'host' }, defaults: { template: 'web' }, vars: { web_port: 'port' } },
      [needsPort],
    );
    expect(targets.map((target) => target.id)).toEqual(['10-0-0-1']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.row).toBe(2);
    expect(issues[0]?.message).toMatch(/needs variable "web_port"/);
  });
});
