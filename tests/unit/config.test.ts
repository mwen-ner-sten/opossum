import { describe, expect, it } from 'vitest';
import {
  isExpectedHttpStatus,
  isValidHost,
  portableConfigurationSchema,
  targetSchema,
} from '@core/config';

describe('configuration validation', () => {
  it('applies safe defaults', () => {
    const target = targetSchema.parse({
      id: 'server-1',
      name: 'Server 1',
      host: 'localhost',
      checks: [{ id: 'ping', name: 'Ping', type: 'ping' }],
    });
    expect(target.enabled).toBe(true);
    expect(target.checks[0]).toMatchObject({ enabled: true, tags: [] });
  });

  it('rejects duplicate target and check IDs with exact paths', () => {
    const duplicateCheck = targetSchema.safeParse({
      id: 'server-1',
      name: 'Server',
      host: 'localhost',
      checks: [
        { id: 'same', name: 'One', type: 'ping' },
        { id: 'same', name: 'Two', type: 'tcp', port: 80 },
      ],
    });
    expect(duplicateCheck.success).toBe(false);
    expect(duplicateCheck.error?.issues[0]?.path).toEqual(['checks', 1, 'id']);
    const duplicateTarget = portableConfigurationSchema.safeParse({
      format_version: 1,
      exported_at: new Date().toISOString(),
      application_version: '0.1.0',
      app: {},
      targets: [
        {
          id: 'same',
          name: 'One',
          host: 'one',
          checks: [{ id: 'ping', name: 'Ping', type: 'ping' }],
        },
        {
          id: 'same',
          name: 'Two',
          host: 'two',
          checks: [{ id: 'ping', name: 'Ping', type: 'ping' }],
        },
      ],
    });
    expect(duplicateTarget.success).toBe(false);
  });

  it('rejects secret headers and unsafe hosts', () => {
    expect(
      targetSchema.safeParse({
        id: 'bad',
        name: 'Bad',
        host: 'localhost & whoami',
        checks: [
          {
            id: 'web',
            name: 'Web',
            type: 'http',
            url: 'https://localhost',
            headers: { Authorization: 'secret' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts real hosts and rejects values that ping could read as flags', () => {
    for (const host of ['localhost', '10.20.30.40', 'pme01.example.internal', '::1', 'fe80::1'])
      expect(isValidHost(host), host).toBe(true);
    for (const host of ['-t', '-l 65500', 'bad host', 'a..b', '999.1.1.1', 'host;whoami', ''])
      expect(isValidHost(host), host).toBe(false);
  });

  it('matches scalar, list, and range HTTP statuses', () => {
    expect(isExpectedHttpStatus(200, 200)).toBe(true);
    expect(isExpectedHttpStatus([200, 401], 401)).toBe(true);
    expect(isExpectedHttpStatus('200-399', 302)).toBe(true);
    expect(isExpectedHttpStatus('200-399', 500)).toBe(false);
  });
});
