import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/config';
import { runHttpCheck } from '@core/checks/http';
import { runTcpCheck } from '@core/checks/tcp';
import { runPingCheck } from '@core/checks/ping';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('local endpoint checks', () => {
  it('completes a native Windows ping', async () => {
    const result = await runPingCheck({
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      check: { id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] },
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('PASS');
  });
  it('passes and fails TCP connections with diagnostics', async () => {
    const server = createNetServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const result = await runTcpCheck({
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      check: { id: 'tcp', name: 'TCP', type: 'tcp', port, enabled: true, tags: [] },
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('PASS');
    expect(result.summary).toContain(`TCP ${port} connected`);
  });

  it('classifies TCP failures and honours cancellation', async () => {
    const base = {
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      settings: { ...DEFAULT_SETTINGS, default_timeout_seconds: 1 },
    };
    const closedServer = createNetServer();
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
    const closedPort = (closedServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));
    const refused = await runTcpCheck({
      ...base,
      signal: new AbortController().signal,
      check: { id: 'tcp', name: 'TCP', type: 'tcp', port: closedPort, enabled: true, tags: [] },
    });
    expect(refused).toMatchObject({ status: 'FAIL', category: 'connection_refused' });
    expect(refused.summary).toBe(`TCP ${closedPort} connection refused`);
    const dns = await runTcpCheck({
      ...base,
      signal: new AbortController().signal,
      target: { ...base.target, host: 'does-not-exist.invalid' },
      check: { id: 'tcp', name: 'TCP', type: 'tcp', port: 80, enabled: true, tags: [] },
    });
    expect(dns).toMatchObject({ category: 'dns', summary: 'TCP 80 host not found' });
    const controller = new AbortController();
    const pending = runTcpCheck({
      ...base,
      signal: controller.signal,
      target: { ...base.target, host: '192.0.2.1' },
      check: { id: 'tcp', name: 'TCP', type: 'tcp', port: 9, enabled: true, tags: [] },
    });
    controller.abort();
    expect(await pending).toMatchObject({ category: 'canceled' });
    const wrongType = await runTcpCheck({
      ...base,
      signal: new AbortController().signal,
      check: { id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] },
    });
    expect(wrongType.category).toBe('unexpected');
  });

  it('supports HEAD requests, forbidden text, manual redirects, and disabled TLS verification', async () => {
    const server = createHttpServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(request.method === 'HEAD' ? undefined : 'maintenance mode');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const base = {
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
    };
    const check = {
      id: 'web',
      name: 'Web',
      type: 'http' as const,
      url: `http://127.0.0.1:${port}/`,
      method: 'GET' as const,
      expected_status: '200-399',
      headers: { 'X-Probe': 'opossum' },
      verify_tls: false,
      follow_redirects: true,
      enabled: true,
      tags: [],
    };
    const head = await runHttpCheck({ ...base, check: { ...check, method: 'HEAD' } });
    expect(head).toMatchObject({ status: 'PASS', details: { tlsVerificationDisabled: true } });
    const forbidden = await runHttpCheck({
      ...base,
      check: { ...check, not_contains: 'maintenance' },
    });
    expect(forbidden).toMatchObject({ status: 'FAIL', category: 'content_forbidden' });
    const manual = await runHttpCheck({
      ...base,
      check: { ...check, url: `http://127.0.0.1:${port}/redirect`, follow_redirects: false },
    });
    expect(manual.details?.httpStatus).toBe(302);
    expect(manual.status).toBe('PASS');
    const wrongType = await runHttpCheck({
      ...base,
      check: { id: 'ping', name: 'Ping', type: 'ping', enabled: true, tags: [] },
    });
    expect(wrongType.category).toBe('unexpected');
  });

  it('validates HTTP status and response content without public internet', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('Power Monitoring Expert');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const result = await runHttpCheck({
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      check: {
        id: 'web',
        name: 'Web',
        type: 'http',
        url: `http://127.0.0.1:${port}/`,
        method: 'GET',
        expected_status: '200-399',
        contains: 'Power Monitoring Expert',
        headers: {},
        verify_tls: true,
        follow_redirects: true,
        enabled: true,
        tags: [],
      },
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: 'PASS', category: 'success' });
    expect(result.details?.httpStatus).toBe(200);
  });

  it('reports unexpected HTTP status and missing required content', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(503);
      response.end('maintenance');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const base = {
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
    };
    const status = await runHttpCheck({
      ...base,
      check: {
        id: 'web',
        name: 'Web',
        type: 'http',
        url: `http://127.0.0.1:${port}/`,
        method: 'GET',
        expected_status: 200,
        headers: {},
        verify_tls: true,
        follow_redirects: true,
        enabled: true,
        tags: [],
      },
    });
    expect(status).toMatchObject({ status: 'FAIL', category: 'http_status' });
    const content = await runHttpCheck({
      ...base,
      check: {
        id: 'web',
        name: 'Web',
        type: 'http',
        url: `http://127.0.0.1:${port}/`,
        method: 'GET',
        expected_status: '200-599',
        contains: 'ready',
        headers: {},
        verify_tls: true,
        follow_redirects: true,
        enabled: true,
        tags: [],
      },
    });
    expect(content).toMatchObject({ status: 'FAIL', category: 'content_missing' });
  });

  it('distinguishes refused, unresolvable, and unresponsive HTTP endpoints', async () => {
    const base = {
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      settings: { ...DEFAULT_SETTINGS, default_timeout_seconds: 1 },
      signal: new AbortController().signal,
    };
    const check = (url: string) => ({
      id: 'web',
      name: 'Web',
      type: 'http' as const,
      url,
      method: 'GET' as const,
      expected_status: '200-399',
      headers: {},
      verify_tls: true,
      follow_redirects: true,
      enabled: true,
      tags: [],
    });
    const closedServer = createNetServer();
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
    const closedPort = (closedServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));
    const refused = await runHttpCheck({
      ...base,
      check: check(`http://127.0.0.1:${closedPort}/`),
    });
    expect(refused).toMatchObject({
      category: 'connection_refused',
      summary: 'HTTP connection refused',
    });
    const dns = await runHttpCheck({ ...base, check: check('http://does-not-exist.invalid/') });
    expect(dns).toMatchObject({ category: 'dns', summary: 'Host not found' });
    const silent = createHttpServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise((resolve) => {
          silent.closeAllConnections();
          silent.close(() => resolve());
        }),
    );
    const port = (silent.address() as { port: number }).port;
    const timeout = await runHttpCheck({ ...base, check: check(`http://127.0.0.1:${port}/`) });
    expect(timeout).toMatchObject({ category: 'timeout', summary: 'HTTP timed out after 1.0 s' });
  });

  it('performs Digest authentication using environment references', async () => {
    let authorization = '';
    const server = createHttpServer((request, response) => {
      authorization = request.headers.authorization ?? '';
      if (!authorization.startsWith('Digest ')) {
        response.writeHead(401, {
          'WWW-Authenticate': 'Digest realm="test", nonce="abc123", algorithm=SHA-256, qop="auth"',
        });
        response.end();
      } else {
        response.writeHead(200);
        response.end('ready');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const result = await runHttpCheck({
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      check: {
        id: 'web',
        name: 'Web',
        type: 'http',
        url: `http://127.0.0.1:${port}/`,
        method: 'GET',
        expected_status: 200,
        headers: {},
        verify_tls: true,
        follow_redirects: true,
        enabled: true,
        tags: [],
        auth: { type: 'digest', username_env: 'USER_NAME', password_env: 'USER_PASSWORD' },
      },
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
      environment: { USER_NAME: 'operator', USER_PASSWORD: 'top-secret' },
    });
    expect(result.status).toBe('PASS');
    expect(authorization).toMatch(/^Digest /);
    expect(authorization).not.toContain('top-secret');
  });

  it('does not reveal missing environment-variable values', async () => {
    const result = await runHttpCheck({
      target: { id: 'local', name: 'Local', host: '127.0.0.1', enabled: true, checks: [] },
      check: {
        id: 'web',
        name: 'Web',
        type: 'http',
        url: 'http://127.0.0.1:1/',
        method: 'GET',
        expected_status: 200,
        headers: {},
        verify_tls: true,
        follow_redirects: true,
        enabled: true,
        tags: [],
        auth: { type: 'basic', username_env: 'MISSING_USER', password_env: 'MISSING_PASSWORD' },
      },
      settings: DEFAULT_SETTINGS,
      signal: new AbortController().signal,
      environment: {},
    });
    expect(result).toMatchObject({ status: 'FAIL', category: 'auth' });
    expect(result.summary).not.toContain('MISSING_PASSWORD');
  });
});
