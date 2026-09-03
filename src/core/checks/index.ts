import type { CheckRunner } from './base';
import { runHttpCheck } from './http';
import { runPingCheck } from './ping';
import { runTcpCheck } from './tcp';

export const CHECK_RUNNERS: Record<'ping' | 'tcp' | 'http', CheckRunner> = {
  ping: runPingCheck,
  tcp: runTcpCheck,
  http: runHttpCheck,
};
