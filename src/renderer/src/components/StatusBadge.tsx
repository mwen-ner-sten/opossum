import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, PauseCircle } from 'lucide-react';
import type { CheckStatus, TimelineStatus } from '@core/models';

export function StatusBadge({
  status,
  subtle = false,
}: {
  status: CheckStatus | TimelineStatus;
  subtle?: boolean;
}) {
  const Icon =
    status === 'PASS'
      ? CircleCheck
      : status === 'FAIL'
        ? CircleAlert
        : status === 'CHECKING'
          ? LoaderCircle
          : status === 'PAUSED'
            ? PauseCircle
            : CircleDashed;
  const label =
    status === 'NOT_MONITORING' ? 'Not monitoring' : status[0] + status.slice(1).toLowerCase();
  return (
    <span
      className={`status status-${status.toLowerCase().replace('_', '-')} ${subtle ? 'status-subtle' : ''}`}
    >
      <Icon size={15} className={status === 'CHECKING' ? 'spin' : ''} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
