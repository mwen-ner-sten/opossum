import { createConnection } from 'node:net';
import type { CheckRunner } from './base';
import { categoryForNetworkError, completeResult, timeoutMs } from './base';

export const runTcpCheck: CheckRunner = async (context) => {
  const started = new Date();
  const check = context.check;
  if (check.type !== 'tcp')
    return completeResult(started, 'FAIL', 'unexpected', 'Invalid TCP configuration');
  const timeout = timeoutMs(context);
  return await new Promise((resolve) => {
    const socket = createConnection({ host: context.target.host, port: check.port });
    let settled = false;
    const finish = (result: ReturnType<typeof completeResult>): void => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(result);
    };
    const abort = (): void =>
      finish(completeResult(started, 'FAIL', 'canceled', `TCP ${check.port} canceled`));
    context.signal.addEventListener('abort', abort, { once: true });
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      const duration = Date.now() - started.getTime();
      finish(
        completeResult(started, 'PASS', 'success', `TCP ${check.port} connected in ${duration} ms`),
      );
    });
    socket.once('timeout', () =>
      finish(
        completeResult(
          started,
          'FAIL',
          'timeout',
          `TCP ${check.port} timed out after ${(timeout / 1000).toFixed(1)} s`,
        ),
      ),
    );
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const category = categoryForNetworkError(error);
      const descriptions = {
        dns: 'host not found',
        connection_refused: 'connection refused',
        timeout: `timed out after ${(timeout / 1000).toFixed(1)} s`,
      } as const;
      const description =
        category in descriptions
          ? descriptions[category as keyof typeof descriptions]
          : error.message;
      finish(completeResult(started, 'FAIL', category, `TCP ${check.port} ${description}`));
    });
  });
};
