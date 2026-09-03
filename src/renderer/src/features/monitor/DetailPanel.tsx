import { ClipboardCopy, Clock3, Copy, RotateCw, X } from 'lucide-react';
import type { CheckConfig, TargetConfig } from '@core/config';
import type { LiveCheckState, TimelineResult } from '@core/models';
import type { AppSnapshot, TimelineRange } from '@shared/contracts';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusBadge } from '../../components/StatusBadge';
import { Timeline } from '../../components/Timeline';
import { expectedStatusText, formatDuration } from './format';

export interface SelectedCheck {
  target: TargetConfig;
  checkId: string;
}

export function DetailPanel({
  selected,
  state,
  settings,
  range,
  timeline,
  onRange,
  onClose,
  onCopy,
}: {
  selected: SelectedCheck;
  state: LiveCheckState | undefined;
  settings: AppSnapshot['settings'];
  range: TimelineRange;
  timeline: TimelineResult | undefined;
  onRange(range: TimelineRange): void;
  onClose(): void;
  onCopy(text: string, label: string): Promise<void>;
}) {
  const check = selected.target.checks.find((item) => item.id === selected.checkId);
  if (!check) return null;
  const result = state?.result ?? state?.lastKnown?.result;
  const resultText = result
    ? `${selected.target.name} / ${check.name}: ${result.status}, ${result.summary} (${new Date(result.completedAt).toLocaleString()})`
    : '';
  const hero = state?.status === 'FAIL' ? 'hero-fail' : state?.status === 'PASS' ? 'hero-pass' : '';
  return (
    <aside className="detail-panel" aria-label="Check details">
      <div className="detail-heading">
        <div>
          <small>{selected.target.name}</small>
          <h2>{check.name}</h2>
          <code>
            {check.type.toUpperCase()} · {check.id}
          </code>
        </div>
        <button className="icon-button" aria-label="Close details" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className={`detail-hero ${hero}`}>
        {state && <StatusBadge status={state.status} chip />}
        <p>{result?.summary ?? 'No completed result yet.'}</p>
        {state?.isHistorical && (
          <span className="history-banner">
            <Clock3 size={14} /> Last known result from an earlier session
          </span>
        )}
        <dl className="hero-stats">
          <div>
            <dt>Response</dt>
            <dd>{formatDuration(result?.durationMs)}</dd>
          </div>
          <div>
            <dt>Checked</dt>
            <dd>
              <RelativeTime value={result?.completedAt} />
            </dd>
          </div>
          <div>
            <dt>Next run</dt>
            <dd>{state?.nextRunAt ? <RelativeTime value={state.nextRunAt} /> : '—'}</dd>
          </div>
        </dl>
      </div>
      <div className="detail-actions">
        <button
          className="button secondary"
          disabled={state?.status === 'PAUSED'}
          onClick={() => void window.opossum.runCheck(selected.target.id, check.id)}
        >
          <RotateCw size={15} /> Run now
        </button>
        <button
          className="button ghost"
          disabled={!result}
          onClick={() => void onCopy(resultText, 'Result')}
        >
          <Copy size={15} /> Copy result
        </button>
        <button
          className="button ghost"
          disabled={!result}
          aria-label="Copy diagnostic text only"
          onClick={() => result && void onCopy(result.summary, 'Diagnostic')}
        >
          <ClipboardCopy size={15} /> Copy diagnostic
        </button>
      </div>
      <section className="detail-section">
        <h3>Schedule</h3>
        <dl className="detail-list">
          <div>
            <dt>Host</dt>
            <dd className="mono">{selected.target.host}</dd>
          </div>
          <div>
            <dt>Interval</dt>
            <dd>{check.interval_seconds ?? settings.default_interval_seconds} seconds</dd>
          </div>
          <div>
            <dt>Timeout</dt>
            <dd>{check.timeout_seconds ?? settings.default_timeout_seconds} seconds</dd>
          </div>
          <div>
            <dt>Fails after</dt>
            <dd>
              {check.failures_before_fail ?? 1} consecutive failure
              {(check.failures_before_fail ?? 1) === 1 ? '' : 's'}
            </dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{result ? new Date(result.completedAt).toLocaleString() : 'Never'}</dd>
          </div>
          {check.tags.length > 0 && (
            <div>
              <dt>Tags</dt>
              <dd>{check.tags.join(', ')}</dd>
            </div>
          )}
        </dl>
      </section>
      {check.type !== 'ping' && (
        <section className="detail-section">
          <h3>{check.type === 'tcp' ? 'TCP' : 'HTTP'}</h3>
          <dl className="detail-list">
            {check.type === 'tcp' && (
              <div>
                <dt>Port</dt>
                <dd className="mono">{check.port}</dd>
              </div>
            )}
            {check.type === 'http' && (
              <HttpDetails check={check} finalUrl={result?.details?.finalUrl} />
            )}
          </dl>
        </section>
      )}
      <div className="timeline-heading">
        <h3>Status timeline</h3>
        <select
          aria-label="Timeline range"
          value={range}
          onChange={(event) => onRange(event.target.value as TimelineRange)}
        >
          <option value="current">Current session</option>
          <option value="previous">Previous session</option>
          <option value="24h">24 hours</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="all">All history</option>
        </select>
      </div>
      <Timeline timeline={timeline} />
    </aside>
  );
}

function HttpDetails({
  check,
  finalUrl,
}: {
  check: Extract<CheckConfig, { type: 'http' }>;
  finalUrl: string | undefined;
}) {
  return (
    <>
      <div>
        <dt>URL</dt>
        <dd className="break mono">
          {check.method} {check.url}
        </dd>
      </div>
      <div>
        <dt>Expected status</dt>
        <dd className="mono">{expectedStatusText(check)}</dd>
      </div>
      {check.contains && (
        <div>
          <dt>Required text</dt>
          <dd className="break">{check.contains}</dd>
        </div>
      )}
      {check.not_contains && (
        <div>
          <dt>Forbidden text</dt>
          <dd className="break">{check.not_contains}</dd>
        </div>
      )}
      <div>
        <dt>TLS</dt>
        <dd>{check.verify_tls ? 'Verified' : 'Verification disabled'}</dd>
      </div>
      <div>
        <dt>Redirects</dt>
        <dd>{check.follow_redirects ? 'Followed' : 'Not followed'}</dd>
      </div>
      {Object.keys(check.headers).length > 0 && (
        <div>
          <dt>Headers</dt>
          <dd className="break">
            {Object.entries(check.headers).map(([name, value]) => (
              <code key={name}>
                {name}: {value}
                <br />
              </code>
            ))}
          </dd>
        </div>
      )}
      {check.auth && (
        <div>
          <dt>Authentication</dt>
          <dd>
            {check.auth.type === 'basic' ? 'Basic' : 'Digest'} ·{' '}
            <code>{check.auth.username_env}</code> / <code>{check.auth.password_env}</code>{' '}
            <span className="redacted">(values never shown)</span>
          </dd>
        </div>
      )}
      {finalUrl && finalUrl !== check.url && (
        <div>
          <dt>Final URL</dt>
          <dd className="break mono">{finalUrl}</dd>
        </div>
      )}
    </>
  );
}
