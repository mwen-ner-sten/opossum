import { ClipboardCopy } from 'lucide-react';
import { VERDICT_LABELS, verdictHeadline, type Verdict, type VerdictSummary } from '@core/verdict';
import { formatClock } from './format';

// OK is the expected outcome, so it sits last; paused checks are outside the comparison.
const CHIPS: readonly Verdict[] = [
  'broke',
  'still_failing',
  'new_failure',
  'blocked',
  'recovered',
  'pending',
  'ok',
];

function baselineText(summary: VerdictSummary): string {
  if (!summary.baselineFrom) return 'No results from an earlier session to compare with';
  const at = (value: string): string =>
    `${new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${formatClock(value)}`;
  const from = at(summary.baselineFrom);
  const to = at(summary.baselineTo ?? summary.baselineFrom);
  // Results a few milliseconds apart read as one moment, not a range.
  return from === to
    ? `Compared with results from before this session, ${from}`
    : `Compared with each check's last result before this session, ${from} – ${to}`;
}

export interface VerdictBarProps {
  summary: VerdictSummary;
  activeFilter: Verdict | 'all';
  onFilter(verdict: Verdict | 'all'): void;
  onCopy(): void;
}

/** Answers "is everything that worked before the patch working now?" at the top of the board. */
export function VerdictBar({ summary, activeFilter, onFilter, onCopy }: VerdictBarProps) {
  const headline = verdictHeadline(summary);
  if (headline.tone === 'none') return null;
  return (
    <section className={`verdict-bar tone-${headline.tone}`} aria-label="Since last session">
      <div className="verdict-text">
        <strong>{headline.text}</strong>
        <small>{baselineText(summary)}</small>
      </div>
      <div className="verdict-chips">
        {CHIPS.filter((verdict) => summary.counts[verdict] > 0).map((verdict) => {
          const active = activeFilter === verdict;
          return (
            <button
              key={verdict}
              type="button"
              className={`verdict-chip verdict-${verdict} ${active ? 'active' : ''}`}
              aria-pressed={active}
              title={active ? 'Show all checks' : `Show only: ${VERDICT_LABELS[verdict]}`}
              onClick={() => onFilter(active ? 'all' : verdict)}
            >
              <strong>{summary.counts[verdict]}</strong> {VERDICT_LABELS[verdict]}
            </button>
          );
        })}
        <button
          type="button"
          className="button ghost"
          title="Copy a before/after summary for a change ticket"
          onClick={onCopy}
        >
          <ClipboardCopy size={14} /> Copy verdict
        </button>
      </div>
    </section>
  );
}
