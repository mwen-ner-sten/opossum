import type { AppSettings, CheckConfig, TargetConfig } from '../config';
import { effectiveTimeout } from '../config';
import type { CheckResult, DiagnosticCategory } from '../models';

export interface CheckContext {
  target: TargetConfig;
  check: CheckConfig;
  settings: AppSettings;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
}

export type CheckRunner = (context: CheckContext) => Promise<CheckResult>;

export function timeoutMs(context: CheckContext): number {
  return effectiveTimeout(context.check, context.settings) * 1_000;
}

export function completeResult(
  startedAt: Date,
  status: 'PASS' | 'FAIL',
  category: DiagnosticCategory,
  summary: string,
  details?: CheckResult['details'],
): CheckResult {
  const completed = new Date();
  return {
    status,
    category,
    summary,
    startedAt: startedAt.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - startedAt.getTime()),
    ...(details ? { details } : {}),
  };
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

/**
 * Walks an error and its `cause` chain (undici's fetch wraps the real failure in
 * `TypeError: fetch failed` with the underlying error on `.cause`) and returns the
 * first diagnostic category that can be determined.
 */
export function categoryForNetworkError(error: unknown, depth = 0): DiagnosticCategory {
  if (depth > 8 || typeof error !== 'object' || error === null) return 'network';
  const record = error as { code?: unknown; name?: unknown; cause?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  const name = typeof record.name === 'string' ? record.name : '';
  if (DNS_CODES.has(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (TIMEOUT_CODES.has(code) || name === 'TimeoutError') return 'timeout';
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))
    return 'tls';
  if (name === 'AbortError') return 'canceled';
  if (record.cause !== undefined && record.cause !== error) {
    const nested = categoryForNetworkError(record.cause, depth + 1);
    if (nested !== 'network') return nested;
  }
  return 'network';
}

/** Returns the innermost message in an error's `cause` chain for operator-facing summaries. */
export function rootErrorMessage(error: unknown, depth = 0): string {
  if (depth > 8 || typeof error !== 'object' || error === null) return 'Unknown network error';
  const record = error as { message?: unknown; cause?: unknown };
  if (record.cause !== undefined && record.cause !== error) {
    const nested = rootErrorMessage(record.cause, depth + 1);
    if (nested !== 'Unknown network error') return nested;
  }
  return typeof record.message === 'string' && record.message
    ? record.message
    : 'Unknown network error';
}
