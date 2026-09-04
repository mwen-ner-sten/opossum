import { useNow } from '../hooks/useNow';
import { formatRelative } from '../features/monitor/format';

/** Self-ticking relative timestamp so the surrounding board does not re-render every second. */
export function RelativeTime({
  value,
  prefix = '',
}: {
  value: string | undefined;
  prefix?: string;
}) {
  const now = useNow();
  return (
    <>
      {prefix}
      {formatRelative(value, now)}
    </>
  );
}
