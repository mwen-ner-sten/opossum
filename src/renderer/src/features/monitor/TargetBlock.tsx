import { ChevronDown, ChevronRight, Copy, Download, RotateCw, Settings2 } from 'lucide-react';
import type { CheckConfig, TargetConfig } from '@core/config';
import type { LiveCheckState } from '@core/models';
import { RelativeTime } from '../../components/RelativeTime';
import { CheckRow } from './CheckRow';
import { targetIssue, type TargetHealth } from './board';
import { countStatuses, summarizeStatuses } from './format';
import { TargetSummary } from './TargetSummary';

export interface TargetBlockProps {
  target: TargetConfig;
  /** Visible checks in step order. */
  checks: readonly CheckConfig[];
  states: readonly LiveCheckState[];
  health: TargetHealth;
  expanded: boolean;
  selectedCheckId: string | undefined;
  missingVariables: readonly string[];
  defaultTimeoutSeconds: number;
  onToggle(): void;
  onSelectCheck(checkId: string): void;
  onEdit(): void;
  onDuplicate(): void;
  onDelete(): void;
}

function latestCheckedAt(states: readonly LiveCheckState[]): string | undefined {
  let latest: string | undefined;
  for (const state of states) {
    const at = (state.result ?? state.lastKnown?.result)?.completedAt;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}

/**
 * One line per target: what is wrong (if anything) and when it was last checked. Expanding
 * shows the individual check rows.
 */
export function TargetBlock({
  target,
  checks,
  states,
  health,
  expanded,
  selectedCheckId,
  missingVariables,
  defaultTimeoutSeconds,
  onToggle,
  onSelectCheck,
  onEdit,
  onDuplicate,
  onDelete,
}: TargetBlockProps) {
  const issue = targetIssue(checks, states);
  const counts = countStatuses(states);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className={`target-block health-${health.level} ${expanded ? 'expanded' : ''}`}>
      <div className="target-line">
        <button
          type="button"
          className="target-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${target.name}`}
          onClick={onToggle}
        >
          <Chevron size={15} className="target-chevron" />
          <span className="health-mark" aria-hidden="true" />
          <span className="target-name">
            <strong>{target.name}</strong>
            <code>{target.host}</code>
          </span>
        </button>
        <TargetSummary
          checks={checks}
          states={states}
          selectedCheckId={selectedCheckId}
          onSelect={onSelectCheck}
        />
        <span className="target-issue">
          {issue ? (
            <button
              type="button"
              className="issue-link"
              title={`${issue.checkName}: ${issue.summary}`}
              onClick={() => onSelectCheck(issue.checkId)}
            >
              <b>{issue.checkName}</b> {issue.summary}
              {issue.others > 0 && <em> +{issue.others} more</em>}
            </button>
          ) : (
            <span className="issue-none">{summarizeStatuses(counts)}</span>
          )}
        </span>
        <span className="target-flags">
          {health.broke > 0 && (
            <em
              className="verdict-pill verdict-broke"
              title="Checks that passed before this session and fail now"
            >
              Broke{health.broke > 1 ? ` ×${health.broke}` : ''}
            </em>
          )}
          {health.recovered > 0 && health.broke === 0 && (
            <em
              className="verdict-pill verdict-recovered"
              title="Checks that failed before this session and pass now"
            >
              Recovered
            </em>
          )}
          {missingVariables.length > 0 && (
            <button
              className="type-pill needs-pill"
              title="Some inherited checks are inactive until template variables are set"
              onClick={onEdit}
            >
              NEEDS {missingVariables.join(', ')}
            </button>
          )}
        </span>
        <span className="target-checked">
          <RelativeTime value={latestCheckedAt(states)} />
        </span>
        <span className="row-actions">
          <button
            className="icon-button"
            aria-label={`Run ${target.name}`}
            title="Run target now"
            onClick={() => void window.opossum.runTarget(target.id)}
          >
            <RotateCw size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`Target actions for ${target.name}`}
            title="Edit target"
            onClick={onEdit}
          >
            <Settings2 size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`Duplicate ${target.name}`}
            title="Duplicate target"
            onClick={onDuplicate}
          >
            <Copy size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`Export ${target.name}`}
            title="Export target as YAML"
            onClick={() => void window.opossum.exportConfiguration({ targetIds: [target.id] })}
          >
            <Download size={15} />
          </button>
        </span>
      </div>
      {expanded && (
        <div className="target-checks">
          {checks.map((check, index) => (
            <CheckRow
              key={check.id}
              target={target}
              check={check}
              state={states[index]!}
              timeoutSeconds={check.timeout_seconds ?? defaultTimeoutSeconds}
              selected={selectedCheckId === check.id}
              onSelect={() => onSelectCheck(check.id)}
            />
          ))}
          <button className="delete-target-link" onClick={onDelete}>
            Delete target…
          </button>
        </div>
      )}
    </div>
  );
}
