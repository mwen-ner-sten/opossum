import { effectiveInterval, effectiveTimeout, type AppSettings, type TargetConfig } from './config';

export type CapacityLevel = 'ok' | 'warning' | 'critical';

export interface CapacityAssessment {
  level: CapacityLevel;
  /** Enabled checks on enabled targets. */
  checkCount: number;
  targetCount: number;
  /** Average check launches per second across the whole configuration. */
  launchesPerSecond: number;
  /**
   * Concurrency needed if every check took its full timeout (Little's law: arrival rate ×
   * service time). Staying under `max_concurrent_checks` keeps a bad day from building a queue.
   */
  worstCaseConcurrency: number;
  configuredConcurrency: number;
  /** worstCaseConcurrency ÷ configuredConcurrency. */
  utilization: number;
  /** Recommended `max_concurrent_checks` for the current check set, when a change would help. */
  suggestedConcurrency?: number;
  /** Recommended `default_interval_seconds` when raising concurrency alone is not enough. */
  suggestedIntervalSeconds?: number;
  findings: string[];
}

const WARN_UTILIZATION = 0.6;
const CRITICAL_UTILIZATION = 1;
const CONCURRENCY_CAP = 200;
const SAFETY_FACTOR = 1.5;
const MIN_INTERVAL_TO_TIMEOUT_RATIO = 3;

/**
 * Judges whether the interval, timeout, and concurrency settings can keep up with the number
 * of checks. Pure so the renderer can show projections before an import is applied.
 */
export function assessCapacity(settings: AppSettings, targets: TargetConfig[]): CapacityAssessment {
  const active = targets.filter((target) => target.enabled);
  let launchesPerSecond = 0;
  let worstCaseConcurrency = 0;
  let checkCount = 0;
  let tightChecks = 0;
  for (const target of active) {
    for (const check of target.checks) {
      if (!check.enabled) continue;
      checkCount += 1;
      const interval = effectiveInterval(check, settings);
      const timeout = effectiveTimeout(check, settings);
      launchesPerSecond += 1 / interval;
      worstCaseConcurrency += timeout / interval;
      if (interval < timeout * MIN_INTERVAL_TO_TIMEOUT_RATIO) tightChecks += 1;
    }
  }
  const configuredConcurrency = settings.max_concurrent_checks;
  const utilization = worstCaseConcurrency / configuredConcurrency;
  const findings: string[] = [];
  let level: CapacityLevel = 'ok';
  const escalate = (next: CapacityLevel): void => {
    if (next === 'critical' || (next === 'warning' && level === 'ok')) level = next;
  };

  const ideal = Math.ceil(worstCaseConcurrency * SAFETY_FACTOR);
  const result: CapacityAssessment = {
    level,
    checkCount,
    targetCount: active.length,
    launchesPerSecond,
    worstCaseConcurrency,
    configuredConcurrency,
    utilization,
    findings,
  };
  if (checkCount === 0) return result;

  if (utilization >= CRITICAL_UTILIZATION) {
    escalate('critical');
    findings.push(
      `If checks time out, ${Math.ceil(worstCaseConcurrency)} would need to run at once but only ${configuredConcurrency} may. Checks will queue and drift past their intervals.`,
    );
  } else if (utilization >= WARN_UTILIZATION) {
    escalate('warning');
    findings.push(
      `Timeouts would use ${Math.round(utilization * 100)}% of the concurrency limit, leaving little headroom for an outage that affects many sites at once.`,
    );
  }
  if (utilization >= WARN_UTILIZATION) {
    if (ideal <= CONCURRENCY_CAP) result.suggestedConcurrency = ideal;
    else {
      result.suggestedConcurrency = CONCURRENCY_CAP;
      // Interval that brings worst-case concurrency under the cap with the safety factor.
      const scale = (worstCaseConcurrency * SAFETY_FACTOR) / CONCURRENCY_CAP;
      result.suggestedIntervalSeconds =
        Math.ceil((settings.default_interval_seconds * scale) / 30) * 30;
      findings.push(
        `Even at the maximum concurrency of ${CONCURRENCY_CAP}, the default interval should rise to about ${result.suggestedIntervalSeconds} seconds for this many checks.`,
      );
    }
  }
  if (tightChecks > 0) {
    escalate('warning');
    findings.push(
      `${tightChecks} check${tightChecks === 1 ? ' has' : 's have'} an interval under ${MIN_INTERVAL_TO_TIMEOUT_RATIO}× the timeout, so a single slow response can delay the next run.`,
    );
  }
  if (launchesPerSecond > 5) {
    escalate('warning');
    findings.push(
      `About ${launchesPerSecond.toFixed(1)} checks launch every second; consider a longer default interval unless sub-minute detection is required.`,
    );
  }
  result.level = level;
  return result;
}
