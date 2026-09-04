import { CircleCheck, Gauge, TriangleAlert } from 'lucide-react';
import type { CapacityAssessment } from '@core/capacity';
import type { AppSettings } from '@core/config';

/**
 * Explains whether the interval, timeout, and concurrency settings can keep up with the number
 * of checks, and offers one-click application of the recommended values.
 */
export function CapacityNote({
  assessment,
  heading,
  compact = false,
  onApply,
}: {
  assessment: CapacityAssessment;
  heading: string;
  compact?: boolean;
  onApply?(patch: Partial<AppSettings>): void;
}) {
  const { level } = assessment;
  const Icon = level === 'ok' ? CircleCheck : level === 'warning' ? TriangleAlert : Gauge;
  const summary =
    assessment.checkCount === 0
      ? 'No enabled checks yet.'
      : `${assessment.checkCount} checks on ${assessment.targetCount} targets launch about ${(assessment.launchesPerSecond * 60).toFixed(1)} runs per minute; if every check timed out, ${assessment.worstCaseConcurrency.toFixed(1)} would run at once against a limit of ${assessment.configuredConcurrency}.`;
  const patch: Partial<AppSettings> = {
    ...(assessment.suggestedConcurrency
      ? { max_concurrent_checks: assessment.suggestedConcurrency }
      : {}),
    ...(assessment.suggestedIntervalSeconds
      ? { default_interval_seconds: assessment.suggestedIntervalSeconds }
      : {}),
  };
  return (
    <div className={`capacity-note ${level} ${compact ? 'compact' : ''}`} role="status">
      <Icon size={16} aria-hidden="true" />
      <div>
        <strong>
          {heading}:{' '}
          {level === 'ok'
            ? 'settings keep up with the check count'
            : level === 'warning'
              ? 'little headroom'
              : 'checks will queue'}
        </strong>
        <p>{summary}</p>
        {assessment.findings.map((finding) => (
          <p key={finding} className="finding">
            {finding}
          </p>
        ))}
        {Object.keys(patch).length > 0 && (
          <p className="suggestion">
            Suggested: {patch.max_concurrent_checks && `concurrency ${patch.max_concurrent_checks}`}
            {patch.max_concurrent_checks && patch.default_interval_seconds && ', '}
            {patch.default_interval_seconds &&
              `default interval ${patch.default_interval_seconds} s`}
            {onApply && (
              <button className="mini-button" onClick={() => onApply(patch)}>
                Apply to the form
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
