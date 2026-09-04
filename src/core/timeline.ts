import { aggregateStatus, type TimelineSegment, type TimelineStatus } from './models';

const rank: Record<TimelineStatus, number> = {
  FAIL: 5,
  UNKNOWN: 3,
  PASS: 2,
  PAUSED: 1,
  NOT_MONITORING: 0,
};

export function observedAvailability(segments: readonly TimelineSegment[]): number | undefined {
  let pass = 0;
  let fail = 0;
  for (const segment of segments) {
    const duration = Math.max(
      0,
      new Date(segment.endAt).getTime() - new Date(segment.startAt).getTime(),
    );
    if (segment.status === 'PASS') pass += duration;
    if (segment.status === 'FAIL') fail += duration;
  }
  return pass + fail === 0 ? undefined : pass / (pass + fail);
}

export function addOfflineGaps(
  segments: readonly TimelineSegment[],
  startAt: string,
  endAt: string,
): TimelineSegment[] {
  const sorted = [...segments].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const result: TimelineSegment[] = [];
  let cursor = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  for (const segment of sorted) {
    const start = Math.max(cursor, new Date(segment.startAt).getTime());
    const segmentEnd = Math.min(end, new Date(segment.endAt).getTime());
    if (start > cursor) {
      result.push({
        id: `gap-${cursor}-${start}`,
        startAt: new Date(cursor).toISOString(),
        endAt: new Date(start).toISOString(),
        status: 'NOT_MONITORING',
        observationCount: 0,
        summary: 'OPOSSUM was not monitoring',
      });
    }
    if (segmentEnd >= start)
      result.push({
        ...segment,
        startAt: new Date(start).toISOString(),
        endAt: new Date(segmentEnd).toISOString(),
      });
    cursor = Math.max(cursor, segmentEnd);
  }
  if (cursor < end) {
    result.push({
      id: `gap-${cursor}-${end}`,
      startAt: new Date(cursor).toISOString(),
      endAt: new Date(end).toISOString(),
      status: 'NOT_MONITORING',
      observationCount: 0,
      summary: 'OPOSSUM was not monitoring',
    });
  }
  return result;
}

export function aggregateTargetTimeline(segments: readonly TimelineSegment[]): TimelineSegment[] {
  if (segments.length === 0) return [];
  const points = [
    ...new Set(segments.flatMap((segment) => [segment.startAt, segment.endAt])),
  ].sort();
  const result: TimelineSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const startAt = points[index];
    const endAt = points[index + 1];
    if (!startAt || !endAt || startAt === endAt) continue;
    const active = segments.filter((segment) => segment.startAt < endAt && segment.endAt > startAt);
    if (active.length === 0) continue;
    const statuses = active.map((segment) => segment.status);
    const status = statuses.reduce((worst, current) =>
      rank[current] > rank[worst] ? current : worst,
    );
    const previous = result.at(-1);
    const observations = active.reduce((sum, item) => sum + item.observationCount, 0);
    if (previous?.status === status && previous.endAt === startAt) {
      result[result.length - 1] = {
        ...previous,
        endAt,
        observationCount: previous.observationCount + observations,
      };
    } else {
      result.push({
        id: `aggregate-${startAt}-${endAt}`,
        startAt,
        endAt,
        status,
        observationCount: observations,
        summary:
          status === 'NOT_MONITORING' ? 'OPOSSUM was not monitoring' : `Target status: ${status}`,
      });
    }
  }
  return result;
}

export { aggregateStatus };
