import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  MoreHorizontal,
  Pause,
  Play,
  RotateCw,
  Search,
  Server,
  Settings2,
} from 'lucide-react';
import type { TargetConfig } from '@core/config';
import { aggregateStatus, type LiveCheckState, type TimelineResult } from '@core/models';
import type { AppSnapshot, TimelineRange } from '@shared/contracts';
import { StatusBadge } from '../components/StatusBadge';
import { Timeline } from '../components/Timeline';

export interface SelectedCheck {
  target: TargetConfig;
  checkId: string;
}

function formatDuration(value?: number): string {
  return value === undefined
    ? '—'
    : value < 1_000
      ? `${Math.round(value)} ms`
      : `${(value / 1_000).toFixed(2)} s`;
}
function formatTime(value?: string): string {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
}

export function MonitorView({
  snapshot,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  snapshot: AppSnapshot;
  onEdit(target: TargetConfig): void;
  onDuplicate(target: TargetConfig): void;
  onDelete(target: TargetConfig): void;
}) {
  const [search, setSearch] = useState(() => localStorage.getItem('filter.search') ?? '');
  const [statusFilter, setStatusFilter] = useState(
    () => localStorage.getItem('filter.status') ?? 'all',
  );
  const [typeFilter, setTypeFilter] = useState(() => localStorage.getItem('filter.type') ?? 'all');
  const [groupFilter, setGroupFilter] = useState(
    () => localStorage.getItem('filter.group') ?? 'all',
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('collapsedGroups') ?? '[]') as string[]),
  );
  const [selected, setSelected] = useState<SelectedCheck>();
  const [range, setRange] = useState<TimelineRange>('current');
  const [timeline, setTimeline] = useState<TimelineResult>();
  const stateMap = useMemo(
    () => new Map(snapshot.states.map((state) => [`${state.targetId}\0${state.checkId}`, state])),
    [snapshot.states],
  );
  const groups = useMemo(() => {
    const result = new Map<string, TargetConfig[]>();
    for (const target of snapshot.targets) {
      const name = target.group || 'Ungrouped';
      result.set(name, [...(result.get(name) ?? []), target]);
    }
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [snapshot.targets]);
  const groupNames = groups.map(([name]) => name);

  useEffect(() => {
    localStorage.setItem('filter.search', search);
    localStorage.setItem('filter.status', statusFilter);
    localStorage.setItem('filter.type', typeFilter);
    localStorage.setItem('filter.group', groupFilter);
  }, [search, statusFilter, typeFilter, groupFilter]);
  useEffect(() => {
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed]));
  }, [collapsed]);
  useEffect(() => {
    if (!selected) {
      setTimeline(undefined);
      return;
    }
    let alive = true;
    setTimeline(undefined);
    void window.opossum
      .getTimeline({ targetId: selected.target.id, checkId: selected.checkId, range })
      .then((value) => {
        if (alive) setTimeline(value);
      });
    return () => {
      alive = false;
    };
  }, [selected, range, snapshot.states]);

  const visible = (target: TargetConfig, checkId: string): boolean => {
    const check = target.checks.find((item) => item.id === checkId)!;
    const state = stateMap.get(`${target.id}\0${checkId}`);
    const haystack =
      `${target.name} ${target.host} ${target.group ?? ''} ${check.name} ${check.tags.join(' ')}`.toLowerCase();
    return (
      (groupFilter === 'all' || (target.group || 'Ungrouped') === groupFilter) &&
      (statusFilter === 'all' || state?.status === statusFilter) &&
      (typeFilter === 'all' || check.type === typeFilter) &&
      haystack.includes(search.toLowerCase())
    );
  };
  const orderedChecks = (target: TargetConfig) =>
    target.checks
      .filter((check) => visible(target, check.id))
      .sort((a, b) => {
        const order = { FAIL: 0, CHECKING: 1, UNKNOWN: 2, PAUSED: 3, PASS: 4 };
        return (
          order[stateMap.get(`${target.id}\0${a.id}`)?.status ?? 'UNKNOWN'] -
          order[stateMap.get(`${target.id}\0${b.id}`)?.status ?? 'UNKNOWN']
        );
      });

  return (
    <div className={`workspace monitor-workspace ${selected ? 'with-details' : ''}`}>
      <div className="workspace-main">
        <section className="filterbar" aria-label="Monitor filters">
          <label className="search">
            <Search size={16} />
            <input
              aria-label="Search targets and checks"
              placeholder="Search targets, hosts, checks, or tags"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            aria-label="Filter by group"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value)}
          >
            <option value="all">All groups</option>
            {groupNames.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            {['FAIL', 'CHECKING', 'UNKNOWN', 'PASS', 'PAUSED'].map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
          <select
            aria-label="Filter by check type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="all">All check types</option>
            <option value="ping">Ping</option>
            <option value="tcp">TCP</option>
            <option value="http">HTTP</option>
          </select>
        </section>
        <div className="table-head">
          <span>Target / check</span>
          <span>Status</span>
          <span>Diagnostic</span>
          <span>Duration</span>
          <span>Last / next</span>
          <span className="sr-only">Actions</span>
        </div>
        <div className="target-groups">
          {groups.map(([group, targets]) => {
            const targetChecks = targets.flatMap((target) => orderedChecks(target));
            if (targetChecks.length === 0) return null;
            const isCollapsed = collapsed.has(group);
            return (
              <section className="target-group" key={group}>
                <button
                  className="group-heading"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group);
                      else next.add(group);
                      return next;
                    })
                  }
                >
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  <span>{group}</span>
                  <small>{targetChecks.length} checks</small>
                </button>
                {!isCollapsed &&
                  targets.map((target) => {
                    const checks = orderedChecks(target);
                    if (checks.length === 0) return null;
                    const targetStatus = aggregateStatus(
                      checks.map(
                        (check) => stateMap.get(`${target.id}\0${check.id}`)?.status ?? 'UNKNOWN',
                      ),
                    );
                    return (
                      <div className="target-block" key={target.id}>
                        <div className="target-heading">
                          <div>
                            <Server size={16} />
                            <strong>{target.name}</strong>
                            <code>{target.host}</code>
                            <StatusBadge status={targetStatus} subtle />
                          </div>
                          <div className="row-actions">
                            <button
                              className="mini-button"
                              onClick={() => void window.opossum.runTarget(target.id)}
                            >
                              <RotateCw size={14} /> Run target
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Target actions for ${target.name}`}
                              onClick={() => onEdit(target)}
                            >
                              <Settings2 size={16} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Duplicate ${target.name}`}
                              onClick={() => onDuplicate(target)}
                            >
                              <MoreHorizontal size={16} />
                            </button>
                          </div>
                        </div>
                        {checks.map((check) => {
                          const state =
                            stateMap.get(`${target.id}\0${check.id}`) ??
                            ({
                              targetId: target.id,
                              checkId: check.id,
                              status: 'UNKNOWN',
                              isHistorical: false,
                            } satisfies LiveCheckState);
                          const result = state.result ?? state.lastKnown?.result;
                          return (
                            <button
                              className={`check-row ${selected?.target.id === target.id && selected.checkId === check.id ? 'selected' : ''}`}
                              key={check.id}
                              onClick={() => setSelected({ target, checkId: check.id })}
                            >
                              <span className="check-identity">
                                <strong>{check.name}</strong>
                                <small>
                                  {check.type.toUpperCase()} · {check.id}
                                </small>
                              </span>
                              <span>
                                <StatusBadge status={state.status} />
                                {state.isHistorical && (
                                  <em className="history-label">Last known</em>
                                )}
                              </span>
                              <span className="diagnostic" title={result?.summary}>
                                {result?.summary ??
                                  (state.status === 'CHECKING'
                                    ? 'Check in progress…'
                                    : 'No result this session')}
                              </span>
                              <span className="tabular">{formatDuration(result?.durationMs)}</span>
                              <span className="times">
                                <span>{formatTime(result?.completedAt)}</span>
                                <small>
                                  {state.nextRunAt
                                    ? `Next ${formatTime(state.nextRunAt)}`
                                    : 'No run queued'}
                                </small>
                              </span>
                              <span
                                className="row-actions"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {state.status === 'PAUSED' ? (
                                  <button
                                    className="icon-button"
                                    aria-label={`Resume ${check.name}`}
                                    onClick={() =>
                                      void window.opossum.resumeCheck(target.id, check.id)
                                    }
                                  >
                                    <Play size={16} />
                                  </button>
                                ) : (
                                  <button
                                    className="icon-button"
                                    aria-label={`Pause ${check.name}`}
                                    onClick={() =>
                                      void window.opossum.pauseCheck(target.id, check.id)
                                    }
                                  >
                                    <Pause size={16} />
                                  </button>
                                )}
                                <button
                                  className="icon-button"
                                  aria-label={`Run ${check.name} now`}
                                  disabled={state.status === 'PAUSED'}
                                  onClick={() => void window.opossum.runCheck(target.id, check.id)}
                                >
                                  <RotateCw size={16} />
                                </button>
                              </span>
                            </button>
                          );
                        })}
                        <button className="delete-target-link" onClick={() => onDelete(target)}>
                          Delete target…
                        </button>
                      </div>
                    );
                  })}
              </section>
            );
          })}
          {groups.length === 0 && (
            <div className="empty-state">
              <div className="empty-mark">
                <Server size={30} />
              </div>
              <h2>No targets configured</h2>
              <p>Add your first endpoint to begin checking it while OPOSSUM is open.</p>
            </div>
          )}
        </div>
      </div>
      {selected &&
        (() => {
          const check = selected.target.checks.find((item) => item.id === selected.checkId)!;
          const state = stateMap.get(`${selected.target.id}\0${selected.checkId}`);
          const result = state?.result ?? state?.lastKnown?.result;
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
                <button
                  className="icon-button"
                  aria-label="Close details"
                  onClick={() => setSelected(undefined)}
                >
                  ×
                </button>
              </div>
              <div className="detail-status">
                {state && <StatusBadge status={state.status} />}
                <p>{result?.summary ?? 'No completed result yet.'}</p>
                {state?.isHistorical && (
                  <span className="history-banner">
                    <Clock3 size={14} /> Last known result from an earlier session
                  </span>
                )}
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
                  onClick={() =>
                    result &&
                    void navigator.clipboard.writeText(
                      `${selected.target.name} / ${check.name}: ${result.status} — ${result.summary} (${new Date(result.completedAt).toLocaleString()})`,
                    )
                  }
                >
                  <Copy size={15} /> Copy result
                </button>
              </div>
              <dl className="detail-list">
                <div>
                  <dt>Host</dt>
                  <dd>{selected.target.host}</dd>
                </div>
                <div>
                  <dt>Interval</dt>
                  <dd>
                    {check.interval_seconds ?? snapshot.settings.default_interval_seconds} seconds
                  </dd>
                </div>
                <div>
                  <dt>Timeout</dt>
                  <dd>
                    {check.timeout_seconds ?? snapshot.settings.default_timeout_seconds} seconds
                  </dd>
                </div>
                <div>
                  <dt>Last checked</dt>
                  <dd>{result ? new Date(result.completedAt).toLocaleString() : 'Never'}</dd>
                </div>
                {check.type === 'tcp' && (
                  <div>
                    <dt>Port</dt>
                    <dd>{check.port}</dd>
                  </div>
                )}
                {check.type === 'http' && (
                  <>
                    <div>
                      <dt>URL</dt>
                      <dd className="break">{check.url}</dd>
                    </div>
                    <div>
                      <dt>TLS</dt>
                      <dd>{check.verify_tls ? 'Verified' : 'Verification disabled'}</dd>
                    </div>
                  </>
                )}
              </dl>
              <div className="timeline-heading">
                <h3>Status timeline</h3>
                <select
                  aria-label="Timeline range"
                  value={range}
                  onChange={(event) => setRange(event.target.value as TimelineRange)}
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
        })()}
    </div>
  );
}
