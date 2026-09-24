import type { CheckConfig, TargetConfig } from './config';
import type { LiveCheckState } from './models';

export interface CheckGuidance {
  title: string;
  explanation: string;
  action?: 'settings' | 'edit' | 'dependency' | 'run' | 'resume' | 'resumeAll';
  label?: string;
}

export function checkGuidance(
  target: TargetConfig,
  check: CheckConfig,
  state: LiveCheckState | undefined,
  pausedAll = false,
): CheckGuidance {
  if (!target.enabled || !check.enabled)
    return {
      title: 'Disabled in configuration',
      explanation: 'Enable this target and check to start monitoring it.',
      action: 'edit',
      label: 'Edit target',
    };
  if (pausedAll)
    return {
      title: 'Monitoring is paused',
      explanation: 'Resume monitoring to continue. Checks paused individually will stay paused.',
      action: 'resumeAll',
      label: 'Resume monitoring',
    };
  if (state?.status === 'PAUSED')
    return {
      title: 'Paused for this session',
      explanation: 'This check will not run until you resume it.',
      action: 'resume',
      label: 'Resume check',
    };
  if (state?.activity === 'queued')
    return {
      title: 'Waiting for capacity',
      explanation:
        'Other checks are using the available slots. This check will run automatically when a slot opens.',
      action: 'settings',
      label: 'Review monitoring capacity',
    };
  const dependency = target.checks.find((item) => item.id === state?.dependencyId);
  if (
    state?.activity === 'dependencies' ||
    (state?.status === 'FAIL' && state.result?.category === 'blocked')
  )
    return {
      title:
        state.activity === 'dependencies'
          ? 'Waiting for a prerequisite'
          : 'Blocked by a prerequisite',
      explanation: `${dependency?.name ?? 'An earlier check'} ${state.activity === 'dependencies' ? 'has not finished with a usable result yet' : 'is failing'}. This check has not probed the endpoint and will run automatically when its prerequisites allow it.`,
      ...(dependency
        ? { action: 'dependency' as const, label: `Inspect ${dependency.name}` }
        : { action: 'edit' as const, label: 'Review dependencies' }),
    };
  if (state?.activity === 'retry')
    return {
      title: 'Confirming a failure',
      explanation: `The failure threshold is ${check.failures_before_fail ?? 1} consecutive failures. Retrying before changing the reported status.`,
    };
  if (state?.status === 'CHECKING')
    return {
      title: 'Check in progress',
      explanation: 'Waiting for the endpoint response or the configured timeout.',
    };
  if (state?.backoffMs)
    return {
      title: 'Retrying less often',
      explanation: `Repeated failures increased the interval to ${Math.round(state.backoffMs / 1000)} seconds. A successful check restores the normal interval.`,
      action: 'run',
      label: 'Try again now',
    };
  if (state?.result?.category === 'auth')
    return {
      title: 'Authentication needs attention',
      explanation:
        'Check the configured environment-variable names and define their values in the environment that launches OPOSSUM, then restart the app. Credential values are never shown here.',
      action: 'edit',
      label: 'Review authentication',
    };
  if (state?.isHistorical)
    return {
      title: 'Waiting for a fresh observation',
      explanation:
        'The displayed result is from an earlier session. It does not establish the endpoint’s current status.',
      action: 'run',
      label: 'Check now',
    };
  if (state?.status === 'FAIL')
    return {
      title: 'Endpoint check failed',
      explanation:
        'Review the diagnostic and check the host, port, or expected response. You can edit the configuration or use Run now to retry.',
      action: 'edit',
      label: 'Review configuration',
    };
  return {
    title: state?.result ? 'Monitoring on schedule' : 'Waiting for the first result',
    explanation: 'The next check runs automatically while OPOSSUM is open.',
  };
}
