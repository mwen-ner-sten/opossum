import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CheckRunner } from './base';
import { completeResult, timeoutMs } from './base';

export const runPingCheck: CheckRunner = async (context) => {
  const started = new Date();
  const timeout = timeoutMs(context);
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timers: { kill?: ReturnType<typeof setTimeout> } = {};
    const settle = (
      status: 'PASS' | 'FAIL',
      category: Parameters<typeof completeResult>[2],
      summary: string,
      roundTripMs?: number,
    ): void => {
      if (settled) return;
      settled = true;
      if (timers.kill) clearTimeout(timers.kill);
      resolve(
        completeResult(
          started,
          status,
          category,
          summary,
          roundTripMs === undefined ? undefined : { roundTripMs },
        ),
      );
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('ping.exe', ['-n', '1', '-w', String(timeout), context.target.host], {
        windowsHide: true,
        shell: false,
        signal: context.signal,
      });
    } catch {
      settle('FAIL', 'executable_missing', 'Windows ping executable is unavailable');
      return;
    }
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError') settle('FAIL', 'canceled', 'Ping canceled');
      else if (error.code === 'ENOENT')
        settle('FAIL', 'executable_missing', 'Windows ping executable is unavailable');
      else settle('FAIL', 'unexpected', `Ping failed: ${error.message}`);
    });
    const handleExit = (code: number | null): void => {
      if (settled) return;
      const output = `${stdout}\n${stderr}`;
      const match = output.match(/time[=<]\s*(\d+)\s*ms/i);
      if (code === 0) {
        const roundTrip = match ? Number(match[1]) : Math.max(0, Date.now() - started.getTime());
        settle('PASS', 'success', `Reply in ${roundTrip} ms`, roundTrip);
      } else if (/could not find host|unknown host/i.test(output)) {
        settle('FAIL', 'dns', 'Host not found');
      } else if (/timed out|unreachable|lost = 1/i.test(output)) {
        settle('FAIL', 'timeout', `Timed out after ${(timeout / 1000).toFixed(1)} s`);
      } else {
        settle('FAIL', 'network', 'No ICMP reply received');
      }
    };
    child.on('exit', handleExit);
    timers.kill = setTimeout(() => {
      child.kill();
      settle('FAIL', 'timeout', `Timed out after ${(timeout / 1000).toFixed(1)} s`);
    }, timeout + 250);
  });
};
