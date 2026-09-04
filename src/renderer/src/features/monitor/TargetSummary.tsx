import type { CheckConfig } from '@core/config';
import type { LiveCheckState } from '@core/models';
import { countStatuses, summarizeStatuses } from './format';

/**
 * One-line target summary plus a strip of pips in step order, so the eye can see where a
 * chain breaks (a failing ping followed by blocked ports) without reading every row.
 */
export function TargetSummary({
  checks,
  states,
  selectedCheckId,
  onSelect,
}: {
  checks: readonly CheckConfig[];
  states: readonly LiveCheckState[];
  selectedCheckId?: string | undefined;
  onSelect(checkId: string): void;
}) {
  const counts = countStatuses(states);
  return (
    <span className="target-summary">
      <span className="step-strip" aria-label="Checks in step order">
        {checks.map((check, index) => {
          const state = states[index]!;
          const blocked = state.status === 'FAIL' && state.result?.category === 'blocked';
          return (
            <button
              key={check.id}
              type="button"
              className={`step-pip pip-${state.status.toLowerCase()} ${blocked ? 'pip-blocked' : ''} ${check.id === selectedCheckId ? 'pip-selected' : ''}`}
              title={`${index + 1}. ${check.name}: ${blocked ? 'blocked' : state.status.toLowerCase()}`}
              aria-label={`Step ${index + 1} ${check.name}, ${blocked ? 'blocked' : state.status.toLowerCase()}`}
              onClick={() => onSelect(check.id)}
            />
          );
        })}
      </span>
      <small>{summarizeStatuses(counts)}</small>
    </span>
  );
}
