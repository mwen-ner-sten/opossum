import { describe, expect, it } from 'vitest';
import type { CheckTemplate, TargetConfig } from '@core/config';
import {
  expandTemplate,
  ownChecks,
  resolveChecks,
  substitute,
  templatePlaceholders,
  validateTemplate,
} from '@core/templates';

const ebo: CheckTemplate = {
  id: 'ebo-server',
  name: 'EBO server',
  checks: [
    { id: 'host-ping', name: 'Ping {{name}}', type: 'ping', enabled: true, tags: ['{{group}}'] },
    { id: 'rdp', name: 'Remote Desktop', type: 'tcp', port: 3389, enabled: true, tags: [] },
    {
      id: 'web',
      name: 'WebStation',
      type: 'http',
      url: 'https://{{host}}:{{vars.port}}/',
      method: 'GET',
      expected_status: [200, 401],
      headers: {},
      verify_tls: false,
      follow_redirects: true,
      enabled: true,
      tags: [],
    },
  ],
};
const site: TargetConfig = {
  id: 'chi-01',
  name: 'Chicago 01',
  host: '10.20.30.40',
  group: 'Chicago',
  enabled: true,
  template: 'ebo-server',
  vars: { port: '8443' },
  checks: [],
};

describe('substitute', () => {
  it('replaces built-in and variable placeholders', () => {
    expect(substitute('{{name}} at {{ host }} in {{group}} ({{id}}) :{{vars.port}}', site)).toBe(
      'Chicago 01 at 10.20.30.40 in Chicago (chi-01) :8443',
    );
  });
  it('throws on unknown or missing placeholders', () => {
    expect(() => substitute('{{nope}}', site)).toThrow(/Unknown placeholder/);
    expect(() => substitute('{{vars.missing}}', site)).toThrow(/vars\.missing/);
  });
});

describe('expandTemplate', () => {
  it('produces concrete checks tagged with the template id', () => {
    const checks = expandTemplate(ebo, site);
    expect(checks.map((check) => check.id)).toEqual(['host-ping', 'rdp', 'web']);
    expect(checks[0]).toMatchObject({
      name: 'Ping Chicago 01',
      tags: ['Chicago'],
      from_template: 'ebo-server',
    });
    expect(checks[2]).toMatchObject({ url: 'https://10.20.30.40:8443/' });
  });
  it('reports which check failed when substitution yields an invalid value', () => {
    expect(() => expandTemplate(ebo, { ...site, vars: { port: 'abc' } })).toThrow(
      /check "web".*url/,
    );
  });
});

describe('resolveChecks', () => {
  it('lets an own check override an inherited one with the same id', () => {
    const own: TargetConfig['checks'][number] = {
      id: 'rdp',
      name: 'Custom RDP',
      type: 'tcp',
      port: 3390,
      enabled: true,
      tags: [],
    };
    const checks = resolveChecks({ ...site, checks: [own] }, ebo);
    // The override takes the template step's place so the step order is unchanged.
    expect(checks.map((check) => check.id)).toEqual(['host-ping', 'rdp', 'web']);
    expect(checks[1]).toMatchObject({ port: 3390 });
    expect(ownChecks({ ...site, checks })).toEqual([own]);
  });
  it('returns own checks only when there is no template', () => {
    expect(resolveChecks({ ...site, template: undefined, checks: [] }, undefined)).toEqual([]);
  });
});

describe('validateTemplate', () => {
  it('lists placeholders and accepts a template that expands cleanly', () => {
    expect(templatePlaceholders(ebo)).toEqual(['name', 'group', 'host', 'vars.port']);
    expect(validateTemplate(ebo).issues).toEqual([]);
  });
  it('rejects schema errors and URLs that stay invalid after expansion', () => {
    expect(validateTemplate({ ...ebo, checks: [] }).issues[0]?.message).toMatch(
      /too small|at least/i,
    );
    const web = ebo.checks[2] as Extract<CheckTemplate['checks'][number], { type: 'http' }>;
    const bad = { ...ebo, checks: [{ ...web, url: 'https://{{host}}:{{vars.port}}x/' }] };
    expect(validateTemplate(bad).issues[0]).toMatchObject({ checkId: 'web' });
  });
});
