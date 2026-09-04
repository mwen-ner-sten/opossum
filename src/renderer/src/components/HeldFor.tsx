import { useNow } from '../hooks/useNow';
import { formatHeld } from '../features/monitor/format';

/** "for 4 min" style duration of the current status; renders nothing under a minute. */
export function HeldFor({
  since,
  prefix = 'for ',
}: {
  since: string | undefined;
  prefix?: string;
}) {
  const now = useNow();
  const held = formatHeld(since, now);
  return held ? (
    <>
      {prefix}
      {held}
    </>
  ) : null;
}
