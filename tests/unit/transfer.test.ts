import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/config';
import { exportConfigurationYaml } from '../../src/main/transfer/export';
import { parseConfigurationYaml, previewImport } from '../../src/main/transfer/import';

describe('YAML transfer', () => {
  const targets = [
    {
      id: 'z-target',
      name: 'Z',
      host: 'z.local',
      enabled: true,
      checks: [{ id: 'z-check', name: 'Z check', type: 'ping' as const, enabled: true, tags: [] }],
    },
    {
      id: 'a-target',
      name: 'A',
      host: 'a.local',
      enabled: true,
      checks: [
        {
          id: 'a-check',
          name: 'A check',
          type: 'http' as const,
          url: 'https://a.local',
          method: 'GET' as const,
          expected_status: '200-399',
          headers: {},
          verify_tls: true,
          follow_redirects: true,
          enabled: true,
          tags: [],
          auth: {
            type: 'basic' as const,
            username_env: 'TEST_USER',
            password_env: 'TEST_PASSWORD',
          },
        },
      ],
    },
  ];

  it('exports deterministically without resolved secrets', () => {
    process.env.TEST_PASSWORD = 'do-not-export';
    const yaml = exportConfigurationYaml(
      DEFAULT_SETTINGS,
      targets,
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(yaml.indexOf('a-target')).toBeLessThan(yaml.indexOf('z-target'));
    expect(yaml).toContain('password_env: TEST_PASSWORD');
    expect(yaml).not.toContain('do-not-export');
    expect(parseConfigurationYaml(yaml).targets).toHaveLength(2);
  });

  it('provides import counts and deleted identity conflicts', () => {
    const incoming = parseConfigurationYaml(exportConfigurationYaml(DEFAULT_SETTINGS, targets));
    const preview = previewImport('example.yaml', incoming, [targets[0]!], targets);
    expect(preview.matchingTargets).toBe(2);
    expect(preview.conflicts).toEqual([
      { kind: 'target', targetId: 'a-target', reason: 'Matches a previously deleted target' },
    ]);
  });

  it('reports invalid YAML as validation errors', () => {
    expect(() => parseConfigurationYaml('targets: [')).toThrow(/could not be parsed/i);
  });
});
