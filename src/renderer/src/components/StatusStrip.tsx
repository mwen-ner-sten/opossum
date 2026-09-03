import type { CheckStatus } from '@core/models';

export type StatusCounts = Record<CheckStatus, number>;
const ORDER: CheckStatus[] = ['FAIL', 'CHECKING', 'UNKNOWN', 'PASS', 'PAUSED'];
const LABELS: Record<CheckStatus, string> = {
  PASS: 'pass',
  FAIL: 'fail',
  CHECKING: 'checking',
  UNKNOWN: 'unknown',
  PAUSED: 'paused',
};

/** Proportional status bar plus clickable counts that toggle the monitor's status filter. */
export function StatusStrip({
  counts,
  activeFilter,
  onFilter,
}: {
  counts: StatusCounts;
  activeFilter: string;
  onFilter(status: CheckStatus | 'all'): void;
}) {
  const total = ORDER.reduce((sum, status) => sum + counts[status], 0);
  return (
    <div className="status-strip" aria-label="Check status counts">
      <div className="status-bar" aria-hidden="true">
        {ORDER.map((status) =>
          counts[status] > 0 ? (
            <span
              key={status}
              className={`bar-${LABELS[status]}`}
              style={{ width: `${(counts[status] / total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="status-counts">
        {ORDER.map((status) => {
          const active = activeFilter === status;
          return (
            <button
              key={status}
              type="button"
              className={`count-${LABELS[status]} ${active ? 'active' : ''} ${counts[status] === 0 ? 'zero' : ''}`}
              aria-pressed={active}
              aria-label={`${counts[status]} ${LABELS[status]}${active ? ', filtering' : ', click to filter'}`}
              onClick={() => onFilter(active ? 'all' : status)}
            >
              <strong>{counts[status]}</strong>
              <small>{LABELS[status]}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
