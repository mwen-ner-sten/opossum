import { useState } from 'react';
import type { TimelineResult, TimelineSegment } from '@core/models';
import { StatusBadge } from './StatusBadge';

function width(segment: TimelineSegment, timeline: TimelineResult): number {
  const total = new Date(timeline.endAt).getTime() - new Date(timeline.startAt).getTime();
  const value = new Date(segment.endAt).getTime() - new Date(segment.startAt).getTime();
  return total <= 0 ? 0 : Math.max(0.4, (value / total) * 100);
}

function duration(segment: TimelineSegment): string {
  const seconds = Math.max(
    0,
    (new Date(segment.endAt).getTime() - new Date(segment.startAt).getTime()) / 1000,
  );
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}

export function Timeline({ timeline }: { timeline?: TimelineResult | undefined }) {
  const [activeId, setActiveId] = useState<string>();
  if (!timeline) return <div className="timeline-skeleton">Loading timeline…</div>;
  if (timeline.segments.length === 0)
    return <div className="timeline-skeleton">No observations in this range.</div>;
  const active = timeline.segments.find((segment) => segment.id === activeId);
  return (
    <div className="timeline-wrap">
      <div className="timeline" aria-label="Status timeline">
        {timeline.segments.map((segment) => (
          <button
            key={segment.id}
            type="button"
            className={`timeline-segment segment-${segment.status.toLowerCase().replace('_', '-')} ${segment.id === activeId ? 'active' : ''}`}
            style={{ width: `${width(segment, timeline)}%` }}
            aria-label={`${segment.status.replace('_', ' ')}: ${segment.summary}, ${duration(segment)}`}
            aria-describedby="timeline-segment-detail"
            onMouseEnter={() => setActiveId(segment.id)}
            onFocus={() => setActiveId(segment.id)}
            onClick={() => setActiveId(segment.id)}
          />
        ))}
      </div>
      <div className="timeline-axis">
        <span>{new Date(timeline.startAt).toLocaleString()}</span>
        <span>{new Date(timeline.endAt).toLocaleString()}</span>
      </div>
      <div className="segment-detail" id="timeline-segment-detail" aria-live="polite">
        {active ? (
          <>
            <StatusBadge status={active.status} />
            <span className="segment-summary">{active.summary}</span>
            <dl>
              <div>
                <dt>From</dt>
                <dd>{new Date(active.startAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>To</dt>
                <dd>{new Date(active.endAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{duration(active)}</dd>
              </div>
              <div>
                <dt>Observations</dt>
                <dd>{active.observationCount}</dd>
              </div>
              {active.averageDurationMs !== undefined && (
                <div>
                  <dt>Response</dt>
                  <dd>
                    {Math.round(active.minDurationMs ?? 0)}–{Math.round(active.maxDurationMs ?? 0)}{' '}
                    ms, avg {Math.round(active.averageDurationMs)} ms
                  </dd>
                </div>
              )}
            </dl>
          </>
        ) : (
          <span className="segment-hint">Hover or focus a segment for details.</span>
        )}
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
