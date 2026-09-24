import type { SessionSummary } from './models';

export interface ReportInterval {
  targetId: string;
  targetName: string;
  host: string;
  checkId: string;
  checkName: string;
  status: string;
  category: string;
  startAt: string;
  endAt: string;
  observations: number;
  summary: string;
}

// Spreadsheet programs interpret formula prefixes even inside quoted CSV fields.
function cell(value: string | number): string {
  const text = String(value);
  const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function sessionCsv(session: SessionSummary, rows: ReportInterval[]): string {
  const header = [
    'Session ID',
    'Target ID',
    'Target name',
    'Host',
    'Check ID',
    'Check name',
    'Status',
    'Category',
    'Start (UTC)',
    'End (UTC)',
    'Duration (seconds)',
    'Observations',
    'Diagnostic',
  ];
  const lines = rows.map((row) =>
    [
      session.id,
      row.targetId,
      row.targetName,
      row.host,
      row.checkId,
      row.checkName,
      row.category === 'blocked' ? 'BLOCKED' : row.status,
      row.category,
      row.startAt,
      row.endAt,
      Math.max(0, Date.parse(row.endAt) - Date.parse(row.startAt)) / 1000,
      row.observations,
      row.summary,
    ]
      .map(cell)
      .join(','),
  );
  return '\uFEFF' + [header.map(cell).join(','), ...lines].join('\r\n') + '\r\n';
}

export function sessionText(
  session: SessionSummary,
  rows: ReportInterval[],
  endAt: string,
): string {
  const failures = rows.filter((row) => row.status === 'FAIL' && row.category !== 'blocked');
  const blocked = rows.filter((row) => row.category === 'blocked');
  const targets = new Set(rows.map((row) => row.targetId));
  const lines = [
    'OPOSSUM monitoring session',
    `Session: ${session.id}`,
    `Window (UTC): ${session.startedAt} to ${endAt}${session.endedAt ? '' : ' (in progress)'}`,
    `${targets.size} targets with retained history; ${failures.length} failure intervals; ${blocked.length} blocked intervals.`,
    'Observed only while OPOSSUM was open. Unknown and paused periods are not evidence of availability.',
    'Names and hosts reflect the retained configuration at export time. History may have been purged.',
    '',
    failures.length ? 'Failures:' : 'No failures in retained observations.',
    ...failures.map(
      (row) =>
        `${row.targetName} (${row.host}) / ${row.checkName}: ${row.startAt} to ${row.endAt} — ${row.summary}`,
    ),
  ];
  if (blocked.length)
    lines.push(
      '',
      'Blocked checks (not probed):',
      ...blocked.map(
        (row) =>
          `${row.targetName} / ${row.checkName}: ${row.startAt} to ${row.endAt} — ${row.summary}`,
      ),
    );
  return lines.join('\n');
}
