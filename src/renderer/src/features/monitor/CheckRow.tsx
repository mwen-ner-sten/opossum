import { memo } from 'react';
import { Pause, Play, RotateCw } from 'lucide-react';
import type { CheckConfig, TargetConfig } from '@core/config';
import type { LiveCheckState } from '@core/models';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDuration, latencyRatio } from './format';

export const CheckRow = memo(function CheckRow({
  target,
  check,
  state,
  timeoutSeconds,
  selected,
  onSelect,
}: {
  target: TargetConfig;
  check: CheckConfig;
  state: LiveCheckState;
  timeoutSeconds: number;
  selected: boolean;
  onSelect(): void;
}) {
  const result = state.result ?? state.lastKnown?.result;
  const ratio = latencyRatio(result?.durationMs, timeoutSeconds);
  const heat = ratio > 0.75 ? 'hot' : ratio > 0.4 ? 'warm' : '';
  const paused = state.status === 'PAUSED';
  const blocked = state.status === 'FAIL' && result?.category === 'blocked';
  return (
    <div
      className={`check-row row-${state.status.toLowerCase()} ${blocked ? 'row-blocked' : ''} ${selected ? 'selected' : ''}`}
    >
      <button
        type="button"
        className="row-select"
        aria-label={`Show details for ${target.name} ${check.name}`}
        aria-pressed={selected}
        onClick={onSelect}
      />
      <span className="check-identity">
        <strong>{check.name}</strong>
        <small>
          <span className={`type-pill type-${check.type}`}>{check.type.toUpperCase()}</span>
          {check.id}
        </small>
      </span>
      <span>
        <StatusBadge status={state.status} blocked={blocked} />
        {state.isHistorical && <em className="history-label">Last known</em>}
      </span>
      <span className="diagnostic" title={result?.summary}>
        {result?.summary ??
          (state.status === 'CHECKING' ? 'Check in progress…' : 'No result this session')}
      </span>
      <span className="latency">
        <span>{formatDuration(result?.durationMs)}</span>
        <span className={`latency-bar ${heat}`} aria-hidden="true">
          <i style={{ width: `${ratio * 100}%` }} />
        </span>
      </span>
      <span className="times">
        <span>
          <RelativeTime value={result?.completedAt} />
        </span>
        <small>
          {state.nextRunAt ? (
            <RelativeTime value={state.nextRunAt} prefix="Next " />
          ) : (
            'No run queued'
          )}
          {state.backoffMs && (
            <span
              className="backoff-tag"
              title={`Backing off: this check keeps failing, so it now runs every ${Math.round(state.backoffMs / 1000)} s`}
            >
              {' '}
              · backoff
            </span>
          )}
        </small>
      </span>
      <span className="row-actions">
        {paused ? (
          <button
            className="icon-button"
            aria-label={`Resume ${check.name}`}
            onClick={() => void window.opossum.resumeCheck(target.id, check.id)}
          >
            <Play size={16} />
          </button>
        ) : (
          <button
            className="icon-button"
            aria-label={`Pause ${check.name}`}
            onClick={() => void window.opossum.pauseCheck(target.id, check.id)}
          >
            <Pause size={16} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label={`Run ${check.name} now`}
          disabled={paused}
          onClick={() => void window.opossum.runCheck(target.id, check.id)}
        >
          <RotateCw size={16} />
        </button>
      </span>
    </div>
  );
});
