import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, PauseCircle } from 'lucide-react';
import type { CheckStatus, TimelineStatus } from '@core/models';

export function StatusBadge({
  status,
  subtle = false,
  chip = false,
}: {
  status: CheckStatus | TimelineStatus;
  subtle?: boolean;
  /** Pill treatment with a tinted background, used where the status is the row's headline. */
  chip?: boolean;
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
  const classes = [
    'status',
    `status-${status.toLowerCase().replace('_', '-')}`,
    subtle ? 'status-subtle' : '',
    chip ? 'chip' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes}>
      <Icon
        size={subtle ? 13 : 15}
        className={status === 'CHECKING' ? 'spin' : ''}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
}
