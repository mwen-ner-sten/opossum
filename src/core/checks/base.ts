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

export function categoryForNetworkError(error: unknown): DiagnosticCategory {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return 'timeout';
  if (
    [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ].includes(code)
  )
    return 'tls';
  if (error instanceof DOMException && error.name === 'AbortError') return 'canceled';
  return 'network';
}
