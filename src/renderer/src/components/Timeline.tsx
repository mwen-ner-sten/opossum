import type { TimelineResult, TimelineSegment } from '@core/models';
import { StatusBadge } from './StatusBadge';

function width(segment: TimelineSegment, timeline: TimelineResult): number {
  const total = new Date(timeline.endAt).getTime() - new Date(timeline.startAt).getTime();
  const value = new Date(segment.endAt).getTime() - new Date(segment.startAt).getTime();
  return total <= 0 ? 0 : Math.max(0.4, (value / total) * 100);
}

export function Timeline({ timeline }: { timeline?: TimelineResult | undefined }) {
  if (!timeline) return <div className="timeline-skeleton">Loading timeline…</div>;
  return (
    <div className="timeline-wrap">
      <div className="timeline" role="list" aria-label="Status timeline">
        {timeline.segments.map((segment) => (
          <button
            key={segment.id}
            role="listitem"
            className={`timeline-segment segment-${segment.status.toLowerCase().replace('_', '-')}`}
            style={{ width: `${width(segment, timeline)}%` }}
            title={`${segment.summary}\n${new Date(segment.startAt).toLocaleString()} – ${new Date(segment.endAt).toLocaleString()}\n${segment.observationCount} observations`}
            aria-label={`${segment.status}: ${segment.summary}`}
          />
        ))}
      </div>
      <div className="timeline-axis">
        <span>{new Date(timeline.startAt).toLocaleString()}</span>
        <span>{new Date(timeline.endAt).toLocaleString()}</span>
      </div>
      <div className="timeline-legend">
        {(['PASS', 'FAIL', 'UNKNOWN', 'PAUSED', 'NOT_MONITORING'] as const).map((status) => (
          <StatusBadge key={status} status={status} subtle />
        ))}
      </div>
      <div className="observed">
        <span>Observed availability</span>
        <strong>
          {timeline.observedAvailability === undefined
            ? 'Not enough observed data'
            : `${(timeline.observedAvailability * 100).toFixed(2)}%`}
        </strong>
        <small>Excludes unknown, paused, and not-monitoring time. Not an SLA.</small>
      </div>
    </div>
  );
}
