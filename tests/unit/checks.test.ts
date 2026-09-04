import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryForNetworkError, rootErrorMessage } from '@core/checks/base';
import { DEFAULT_SETTINGS } from '@core/config';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

function fakePing(stdout: string, code: number) {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('exit', code);
    }, 0);
    return child;
  });
}
const context = {
  target: { id: 't', name: 'T', host: '10.0.0.5', enabled: true, checks: [] },
  check: { id: 'ping', name: 'Ping', type: 'ping' as const, enabled: true, tags: [] },
  settings: DEFAULT_SETTINGS,
  signal: new AbortController().signal,
};
afterEach(() => spawnMock.mockReset());

describe('network error classification', () => {
  it('unwraps undici fetch failures to the underlying cause', () => {
    const wrap = (code: string) =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    expect(categoryForNetworkError(wrap('ECONNREFUSED'))).toBe('connection_refused');
    expect(categoryForNetworkError(wrap('ENOTFOUND'))).toBe('dns');
    expect(categoryForNetworkError(wrap('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout');
    expect(categoryForNetworkError(wrap('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('tls');
    expect(categoryForNetworkError(wrap('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls');
    expect(rootErrorMessage(wrap('ECONNRESET'))).toBe('ECONNRESET');
  });

  it('recognises AbortSignal.timeout and abort reasons', () => {
    expect(categoryForNetworkError(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
    expect(categoryForNetworkError(new DOMException('aborted', 'AbortError'))).toBe('canceled');
    expect(categoryForNetworkError(new Error('plain'))).toBe('network');
    expect(categoryForNetworkError('string')).toBe('network');
  });
});

describe('ping output parsing', () => {
  it('passes only on a genuine echo reply', async () => {
    const { runPingCheck } = await import('@core/checks/ping');
    fakePing('Reply from 10.0.0.5: bytes=32 time=18ms TTL=64\nLost = 0 (0% loss)', 0);
    expect(await runPingCheck(context)).toMatchObject({
      status: 'PASS',
      details: { roundTripMs: 18 },
    });
  });

  it('fails when a router reports the destination unreachable even though ping exits 0', async () => {
    const { runPingCheck } = await import('@core/checks/ping');
    fakePing('Reply from 10.0.0.1: Destination host unreachable.\nLost = 0 (0% loss)', 0);
    expect(await runPingCheck(context)).toMatchObject({
      status: 'FAIL',
      category: 'network',
      summary: 'Destination host unreachable',
    });
  });

  it('classifies timeouts and unknown hosts', async () => {
    const { runPingCheck } = await import('@core/checks/ping');
    fakePing('Request timed out.\nLost = 1 (100% loss)', 1);
    expect(await runPingCheck(context)).toMatchObject({ status: 'FAIL', category: 'timeout' });
    fakePing('Ping request could not find host nope.invalid.', 1);
    expect(await runPingCheck(context)).toMatchObject({ status: 'FAIL', category: 'dns' });
  });
});
