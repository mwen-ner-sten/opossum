import { createHash, randomBytes } from 'node:crypto';
import { Agent, fetch, type Response } from 'undici';
import { isExpectedHttpStatus, type HttpCheckConfig } from '../config';
import type { CheckResult } from '../models';
import type { CheckContext, CheckRunner } from './base';
import { categoryForNetworkError, completeResult, timeoutMs } from './base';

const BODY_LIMIT = 1024 * 1024;

function credentials(
  check: HttpCheckConfig,
  environment: NodeJS.ProcessEnv,
): { username: string; password: string } | undefined {
  if (!check.auth) return undefined;
  const username = environment[check.auth.username_env];
  const password = environment[check.auth.password_env];
  if (username === undefined || password === undefined) return undefined;
  return { username, password };
}

function digestHeader(
  challenge: string,
  method: string,
  url: URL,
  username: string,
  password: string,
): string {
  const entries = new Map<string, string>();
  const value = challenge.replace(/^Digest\s+/i, '');
  for (const match of value.matchAll(/([a-z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/gi))
    entries.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? '');
  const realm = entries.get('realm');
  const nonce = entries.get('nonce');
  if (!realm || !nonce) throw new Error('Invalid Digest authentication challenge');
  const algorithm = (entries.get('algorithm') ?? 'MD5').toUpperCase();
  const hashName = algorithm.startsWith('SHA-256')
    ? 'sha256'
    : algorithm.startsWith('MD5')
      ? 'md5'
      : undefined;
  if (!hashName) throw new Error(`Unsupported Digest algorithm: ${algorithm}`);
  const qops = (entries.get('qop') ?? '').split(',').map((item) => item.trim());
  if (qops[0] && !qops.includes('auth')) throw new Error('Digest auth-int is not supported');
  const hash = (input: string): string => createHash(hashName).update(input).digest('hex');
  const uri = `${url.pathname}${url.search}` || '/';
  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  let ha1 = hash(`${username}:${realm}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = qops.includes('auth')
    ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : hash(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${username.replaceAll('"', '\\"')}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (entries.get('opaque')) parts.push(`opaque="${entries.get('opaque')}"`);
  if (qops.includes('auth')) parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

async function readBounded(body: Response['body']): Promise<{ text: string; bytes: number }> {
  if (!body) return { text: '', bytes: 0 };
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = body.getReader();
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    const buffer = Buffer.from(item.value as Uint8Array);
    const remaining = BODY_LIMIT - bytes;
    if (remaining <= 0) {
      await reader.cancel();
      break;
    }
    chunks.push(buffer.subarray(0, remaining));
    bytes += Math.min(buffer.length, remaining);
    if (bytes >= BODY_LIMIT) {
      await reader.cancel();
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

async function executeRequest(context: CheckContext, authorization?: string): Promise<Response> {
  const check = context.check as HttpCheckConfig;
  const dispatcher = check.verify_tls
    ? undefined
    : new Agent({ connect: { rejectUnauthorized: false } });
  const headers = { ...check.headers, ...(authorization ? { authorization } : {}) };
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs(context))]);
  return await fetch(check.url, {
    method: check.method,
    headers,
    redirect: check.follow_redirects ? 'follow' : 'manual',
    signal,
    ...(dispatcher ? { dispatcher } : {}),
  });
}

export const runHttpCheck: CheckRunner = async (context) => {
  const started = new Date();
  const check = context.check;
  if (check.type !== 'http')
    return completeResult(started, 'FAIL', 'unexpected', 'Invalid HTTP configuration');
  const environment = context.environment ?? process.env;
  const secret = credentials(check, environment);
  if (check.auth && !secret)
    return completeResult(
      started,
      'FAIL',
      'auth',
      'Authentication environment variables are not set',
    );
  let authorization =
    check.auth?.type === 'basic' && secret
      ? `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString('base64')}`
      : undefined;
  try {
    let response = await executeRequest(context, authorization);
    if (response.status === 401 && check.auth?.type === 'digest' && secret) {
      await response.body?.cancel();
      const digestChallenge = response.headers.get('www-authenticate') ?? undefined;
      if (!digestChallenge || !/^Digest\s/i.test(digestChallenge))
        return completeResult(started, 'FAIL', 'auth', 'Server did not provide a Digest challenge');
      authorization = digestHeader(
        digestChallenge,
        check.method,
        new URL(check.url),
        secret.username,
        secret.password,
      );
      response = await executeRequest(context, authorization);
    }
    const { text, bytes } =
      check.method === 'HEAD' ? { text: '', bytes: 0 } : await readBounded(response.body);
    const duration = Date.now() - started.getTime();
    const details: CheckResult['details'] = {
      httpStatus: response.status,
      finalUrl: response.url || check.url,
      responseBytes: Number(response.headers.get('content-length') ?? bytes),
      ...(!check.verify_tls ? { tlsVerificationDisabled: true } : {}),
    };
    if (!isExpectedHttpStatus(check.expected_status, response.status))
      return completeResult(
        started,
        'FAIL',
        'http_status',
        `HTTP ${response.status}; expected ${Array.isArray(check.expected_status) ? check.expected_status.join(', ') : check.expected_status}`,
        details,
      );
    if (check.contains !== undefined && !text.includes(check.contains))
      return completeResult(
        started,
        'FAIL',
        'content_missing',
        `HTTP ${response.status}; required text not found`,
        details,
      );
    if (check.not_contains !== undefined && text.includes(check.not_contains))
      return completeResult(
        started,
        'FAIL',
        'content_forbidden',
        `HTTP ${response.status}; forbidden text found`,
        details,
      );
    return completeResult(
      started,
      'PASS',
      'success',
      `HTTP ${response.status} in ${duration} ms`,
      details,
    );
  } catch (error) {
    const category = categoryForNetworkError(error);
    const summary =
      category === 'tls'
        ? 'TLS certificate validation failed'
        : category === 'timeout'
          ? `HTTP timed out after ${(timeoutMs(context) / 1000).toFixed(1)} s`
          : category === 'canceled'
            ? 'HTTP check canceled'
            : `HTTP request failed: ${error instanceof Error ? error.message : 'Unknown network error'}`;
    return completeResult(
      started,
      'FAIL',
      category,
      summary,
      !check.verify_tls ? { tlsVerificationDisabled: true } : undefined,
    );
  }
};
