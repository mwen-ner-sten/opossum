export const CHECK_STATUSES = ['UNKNOWN', 'CHECKING', 'PASS', 'FAIL', 'PAUSED'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type PersistedStatus = Exclude<CheckStatus, 'CHECKING'>;
export type CheckType = 'ping' | 'tcp' | 'http';

export type DiagnosticCategory =
  | 'success'
  | 'timeout'
  | 'dns'
  | 'connection_refused'
  | 'network'
  | 'http_status'
  | 'content_missing'
  | 'content_forbidden'
  | 'tls'
  | 'auth'
  | 'executable_missing'
  | 'paused'
  | 'blocked'
  | 'unknown'
  | 'canceled'
  | 'unexpected';

export interface CheckResult {
  status: 'PASS' | 'FAIL';
  category: DiagnosticCategory;
  summary: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  details?: {
    roundTripMs?: number;
    httpStatus?: number;
    finalUrl?: string;
    responseBytes?: number;
    tlsVerificationDisabled?: boolean;
  };
}

export interface LastKnownState {
  targetId: string;
  checkId: string;
  result: CheckResult;
  /** Absent when the session that produced the result has since been purged. */
  sessionId?: string;
}

export interface LiveCheckState {
  targetId: string;
  checkId: string;
  status: CheckStatus;
  result?: CheckResult;
  lastKnown?: LastKnownState;
  nextRunAt?: string | undefined;
  /** Present while failure backoff has stretched the interval; the stretched interval in ms. */
  backoffMs?: number | undefined;
  /** When the current PASS/FAIL status was first observed this session. */
  statusSince?: string | undefined;
  isHistorical: boolean;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  lastHeartbeatAt: string;
  applicationVersion: string;
  cleanShutdown: boolean;
  inferredEndAt?: string;
  passCount: number;
  failCount: number;
}

export type TimelineStatus = PersistedStatus | 'NOT_MONITORING';

export interface TimelineSegment {
  id: string;
  sessionId?: string;
  startAt: string;
  endAt: string;
  status: TimelineStatus;
  category?: DiagnosticCategory;
  observationCount: number;
  summary: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  averageDurationMs?: number;
}

export interface TimelineResult {
  startAt: string;
  endAt: string;
  segments: TimelineSegment[];
  observedAvailability?: number;
}

export function aggregateStatus(states: readonly CheckStatus[]): CheckStatus {
  const active = states.filter((status) => status !== 'PAUSED');
  if (active.includes('FAIL')) return 'FAIL';
  if (active.includes('CHECKING')) return 'CHECKING';
  if (active.includes('UNKNOWN')) return 'UNKNOWN';
  if (active.includes('PASS')) return 'PASS';
  return 'PAUSED';
}
