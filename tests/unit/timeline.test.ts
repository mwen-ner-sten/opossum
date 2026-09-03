import { describe, expect, it } from 'vitest';
import { addOfflineGaps, aggregateTargetTimeline, observedAvailability } from '@core/timeline';
import type { TimelineSegment } from '@core/models';

const segment = (
  id: string,
  start: number,
  end: number,
  status: TimelineSegment['status'],
): TimelineSegment => ({
  id,
  startAt: new Date(start).toISOString(),
  endAt: new Date(end).toISOString(),
  status,
  observationCount: 1,
  summary: status,
});

describe('timeline math', () => {
  it('marks unmonitored gaps and excludes them from observed availability', () => {
    const segments = addOfflineGaps(
      [segment('pass', 1_000, 3_000, 'PASS'), segment('fail', 5_000, 6_000, 'FAIL')],
      new Date(0).toISOString(),
      new Date(8_000).toISOString(),
    );
    expect(segments.filter((item) => item.status === 'NOT_MONITORING')).toHaveLength(3);
    expect(observedAvailability(segments)).toBeCloseTo(2 / 3);
  });

  it('uses worst state when aggregating target checks', () => {
    const segments = aggregateTargetTimeline([
      segment('pass', 0, 10_000, 'PASS'),
      segment('fail', 2_000, 4_000, 'FAIL'),
    ]);
    expect(segments.map((item) => item.status)).toEqual(['PASS', 'FAIL', 'PASS']);
  });
});
