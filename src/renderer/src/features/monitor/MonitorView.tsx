import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  LayoutList,
  Copy,
  Download,
  RotateCw,
  Search,
  Server,
  Settings2,
  X,
} from 'lucide-react';
import type { CheckConfig, TargetConfig } from '@core/config';
import {
  aggregateStatus,
  type CheckStatus,
  type LiveCheckState,
  type TimelineResult,
} from '@core/models';
import type { AppSnapshot, TimelineRange } from '@shared/contracts';
import { missingTemplateVariables } from '@core/templates';
import { StatusBadge } from '../../components/StatusBadge';
import { CheckRow } from './CheckRow';
import { DetailPanel, type SelectedCheck } from './DetailPanel';
import { countStatuses, keyFor, summarizeStatuses } from './format';
import { TargetSummary } from './TargetSummary';

const PIP_ORDER: CheckStatus[] = ['FAIL', 'CHECKING', 'UNKNOWN', 'PASS', 'PAUSED'];

function useStoredValue(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? fallback);
  useEffect(() => localStorage.setItem(key, value), [key, value]);
  return [value, setValue];
}

export function MonitorView({
  snapshot,
  statusFilter,
  onStatusFilter,
  onEdit,
  onDuplicate,
  onDelete,
  onNotice,
}: {
  snapshot: AppSnapshot;
  statusFilter: string;
  onStatusFilter(status: string): void;
  onEdit(target: TargetConfig): void;
  onDuplicate(target: TargetConfig): void;
  onDelete(target: TargetConfig): void;
  onNotice(message: string): void;
}) {
  const [search, setSearch] = useStoredValue('filter.search', '');
  const [typeFilter, setTypeFilter] = useStoredValue('filter.type', 'all');
  const [groupFilter, setGroupFilter] = useStoredValue('filter.group', 'all');
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('collapsedGroups') ?? '[]') as string[]),
  );
  const [collapsedTargets, setCollapsedTargets] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('collapsedTargets') ?? '[]') as string[]),
  );
  const [selected, setSelected] = useState<SelectedCheck>();
  const [range, setRange] = useState<TimelineRange>('current');
  const [timeline, setTimeline] = useState<TimelineResult>();
  const searchRef = useRef<HTMLInputElement>(null);
  const stateMap = useMemo(
    () => new Map(snapshot.states.map((state) => [keyFor(state.targetId, state.checkId), state])),
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

  useEffect(() => {
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed]));
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem('collapsedTargets', JSON.stringify([...collapsedTargets]));
  }, [collapsedTargets]);
  const toggleTarget = (id: string): void =>
    setCollapsedTargets((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Bulk expand/collapse: with hundreds of hosts, per-row clicking is not workable.
  const viewMenu = useRef<HTMLDetailsElement>(null);
  const setTargetsCollapsed = (ids: readonly string[], collapse: boolean): void => {
    setCollapsedTargets((current) => {
      const next = new Set(current);
      for (const id of ids)
        if (collapse) next.add(id);
        else next.delete(id);
      return next;
    });
    if (viewMenu.current) viewMenu.current.open = false;
  };
  const setGroupsCollapsed = (names: readonly string[], collapse: boolean): void => {
    setCollapsed(collapse ? new Set(names) : new Set());
    if (viewMenu.current) viewMenu.current.open = false;
  };
  // "/" focuses search from anywhere on the board, like most operator consoles.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'Escape' && !typing && selected) setSelected(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // Only the selected check's own completed results should refresh its timeline, not every
  // status event from every other check.
  const selectedState = selected
    ? stateMap.get(keyFor(selected.target.id, selected.checkId))
    : undefined;
  const selectedCompletedAt = selectedState?.result?.completedAt;
  useEffect(() => {
    if (!selected) {
      setTimeline(undefined);
      return;
    }
    let alive = true;
    void window.opossum
      .getTimeline({ targetId: selected.target.id, checkId: selected.checkId, range })
      .then((value) => {
        if (alive) setTimeline(value);
      })
      .catch(() => {
        if (alive) setTimeline(undefined);
      });
    return () => {
      alive = false;
    };
  }, [selected, range, selectedCompletedAt]);

  const stateOf = (target: TargetConfig, check: CheckConfig): LiveCheckState =>
    stateMap.get(keyFor(target.id, check.id)) ?? {
      targetId: target.id,
      checkId: check.id,
      status: 'UNKNOWN',
      isHistorical: false,
    };
  const visible = (target: TargetConfig, check: CheckConfig): boolean => {
    const haystack =
      `${target.name} ${target.host} ${target.group ?? ''} ${check.name} ${check.tags.join(' ')}`.toLowerCase();
    return (
      (groupFilter === 'all' || (target.group || 'Ungrouped') === groupFilter) &&
      (statusFilter === 'all' || stateOf(target, check).status === statusFilter) &&
      (typeFilter === 'all' || check.type === typeFilter) &&
      haystack.includes(search.toLowerCase())
    );
  };
  // Checks stay in step order so the board reads like the template: ping, then ports, then web.
  const orderedChecks = (target: TargetConfig): CheckConfig[] =>
    target.checks.filter((check) => visible(target, check));
  const copy = async (text: string, label: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    onNotice(`${label} copied`);
  };
  const filtering =
    search !== '' || statusFilter !== 'all' || typeFilter !== 'all' || groupFilter !== 'all';
  const clearFilters = (): void => {
    setSearch('');
    setTypeFilter('all');
    setGroupFilter('all');
    onStatusFilter('all');
  };
  const totalChecks = snapshot.targets.reduce((sum, target) => sum + target.checks.length, 0);
  const groupNames = groups.map(([group]) => group);
  const allTargetIds = snapshot.targets.map((target) => target.id);
  const visibleChecks = snapshot.targets.reduce(
    (sum, target) => sum + target.checks.filter((check) => visible(target, check)).length,
    0,
  );

  return (
    <div className={`workspace monitor-workspace ${selected ? 'with-details' : ''}`}>
      <div className="workspace-main">
        <section className="filterbar" aria-label="Monitor filters">
          <label className="search">
            <Search size={16} />
            <input
              ref={searchRef}
              aria-label="Search targets and checks"
              placeholder="Search targets, hosts, checks, or tags"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd aria-hidden="true">/</kbd>
          </label>
          <select
            aria-label="Filter by group"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value)}
          >
            <option value="all">All groups</option>
            {groups.map(([group]) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => onStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            {PIP_ORDER.map((status) => (
              <option key={status} value={status}>
                {status[0] + status.slice(1).toLowerCase()}
              </option>
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
          <button
            type="button"
            className={`button ghost problems-toggle ${statusFilter === 'FAIL' ? 'active' : ''}`}
            aria-pressed={statusFilter === 'FAIL'}
            title="Show only failing and blocked checks"
            onClick={() => onStatusFilter(statusFilter === 'FAIL' ? 'all' : 'FAIL')}
          >
            <CircleAlert size={14} /> Problems only
          </button>
          <details className="view-menu" ref={viewMenu}>
            <summary className="button ghost" title="Expand or collapse groups and targets">
              <LayoutList size={14} /> View
            </summary>
            <div className="view-menu-list" role="menu">
              <button role="menuitem" onClick={() => setGroupsCollapsed(groupNames, false)}>
                Expand all groups
              </button>
              <button role="menuitem" onClick={() => setGroupsCollapsed(groupNames, true)}>
                Collapse all groups
              </button>
              <hr />
              <button role="menuitem" onClick={() => setTargetsCollapsed(allTargetIds, false)}>
                Expand all targets
              </button>
              <button role="menuitem" onClick={() => setTargetsCollapsed(allTargetIds, true)}>
                Collapse all targets
              </button>
              <hr />
              <button
                role="menuitem"
                onClick={() => {
                  setGroupsCollapsed(groupNames, false);
                  setTargetsCollapsed(allTargetIds, false);
                }}
              >
                Expand everything
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setGroupsCollapsed(groupNames, true);
                  setTargetsCollapsed(allTargetIds, true);
                }}
              >
                Collapse everything
              </button>
            </div>
          </details>
          {filtering ? (
            <button className="button ghost filter-clear" onClick={clearFilters}>
              <X size={14} /> Clear ({visibleChecks} of {totalChecks})
            </button>
          ) : (
            <span className="filter-summary">{totalChecks} checks</span>
          )}
        </section>
        <div className="table-head">
          <span>Target / check</span>
          <span>Status</span>
          <span>Diagnostic</span>
          <span>Response</span>
          <span>Checked / next</span>
          <span className="sr-only">Actions</span>
        </div>
        <div className="target-groups">
          {groups.map(([group, targets]) => {
            const groupStates = targets.flatMap((target) =>
              orderedChecks(target).map((check) => stateOf(target, check)),
            );
            const targetChecks = groupStates.map((state) => state.status);
            if (targetChecks.length === 0) return null;
            const isCollapsed = collapsed.has(group);
            const shownTargets = targets.filter((target) => orderedChecks(target).length > 0);
            const groupIds = shownTargets.map((target) => target.id);
            const anyExpanded = groupIds.some((id) => !collapsedTargets.has(id));
            return (
              <section className="target-group" key={group}>
                <div className="group-heading">
                  <button
                    type="button"
                    className="group-toggle"
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
                    <small>
                      {shownTargets.length} target{shownTargets.length === 1 ? '' : 's'} ·{' '}
                      {summarizeStatuses(countStatuses(groupStates))}
                    </small>
                  </button>
                  {!isCollapsed && (
                    <button
                      type="button"
                      className="icon-button group-fold"
                      aria-label={`${anyExpanded ? 'Collapse' : 'Expand'} all targets in ${group}`}
                      title={
                        anyExpanded
                          ? 'Collapse targets in this group'
                          : 'Expand targets in this group'
                      }
                      onClick={() => setTargetsCollapsed(groupIds, anyExpanded)}
                    >
                      {anyExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                    </button>
                  )}
                  <span className="group-pips" aria-hidden="true">
                    {PIP_ORDER.flatMap((status) =>
                      targetChecks
                        .filter((item) => item === status)
                        .map((_, index) => (
                          <i key={`${status}-${index}`} className={`pip-${status.toLowerCase()}`} />
                        )),
                    )}
                  </span>
                </div>
                {!isCollapsed &&
                  targets.map((target) => {
                    const checks = orderedChecks(target);
                    if (checks.length === 0) return null;
                    const states = checks.map((check) => stateOf(target, check));
                    const targetStatus = aggregateStatus(states.map((state) => state.status));
                    const targetCollapsed = collapsedTargets.has(target.id);
                    return (
                      <div
                        className={`target-block ${targetCollapsed ? 'collapsed' : ''}`}
                        key={target.id}
                      >
                        <div className="target-heading">
                          <div>
                            <button
                              type="button"
                              className="icon-button collapse-toggle"
                              aria-expanded={!targetCollapsed}
                              aria-label={`${targetCollapsed ? 'Expand' : 'Collapse'} ${target.name}`}
                              onClick={() => toggleTarget(target.id)}
                            >
                              {targetCollapsed ? (
                                <ChevronRight size={15} />
                              ) : (
                                <ChevronDown size={15} />
                              )}
                            </button>
                            <Server size={15} />
                            <strong>{target.name}</strong>
                            <code>{target.host}</code>
                            <StatusBadge status={targetStatus} subtle />
                            <TargetSummary
                              checks={checks}
                              states={states}
                              selectedCheckId={
                                selected?.target.id === target.id ? selected.checkId : undefined
                              }
                              onSelect={(checkId) => {
                                setSelected({ target, checkId });
                                if (targetCollapsed) toggleTarget(target.id);
                              }}
                            />
                            {missingTemplateVariables(
                              target,
                              snapshot.templates.find((item) => item.id === target.template),
                            ).length > 0 && (
                              <button
                                className="type-pill needs-pill"
                                title="Some inherited checks are inactive until template variables are set"
                                onClick={() => onEdit(target)}
                              >
                                NEEDS{' '}
                                {missingTemplateVariables(
                                  target,
                                  snapshot.templates.find((item) => item.id === target.template),
                                ).join(', ')}
                              </button>
                            )}
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
                              title="Edit target"
                              onClick={() => onEdit(target)}
                            >
                              <Settings2 size={16} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Duplicate ${target.name}`}
                              title="Duplicate target"
                              onClick={() => onDuplicate(target)}
                            >
                              <Copy size={16} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Export ${target.name}`}
                              title="Export target as YAML"
                              onClick={() =>
                                void window.opossum.exportConfiguration({ targetIds: [target.id] })
                              }
                            >
                              <Download size={16} />
                            </button>
                          </div>
                        </div>
                        {!targetCollapsed &&
                          checks.map((check) => (
                            <CheckRow
                              key={check.id}
                              target={target}
                              check={check}
                              state={stateOf(target, check)}
                              timeoutSeconds={
                                check.timeout_seconds ?? snapshot.settings.default_timeout_seconds
                              }
                              selected={
                                selected?.target.id === target.id && selected.checkId === check.id
                              }
                              onSelect={() => setSelected({ target, checkId: check.id })}
                            />
                          ))}
                        {!targetCollapsed && (
                          <button className="delete-target-link" onClick={() => onDelete(target)}>
                            Delete target…
                          </button>
                        )}
                      </div>
                    );
                  })}
              </section>
            );
          })}
          {groups.length === 0 && (
            <div className="empty-state">
              <div className="empty-mark">
                <Server size={26} />
              </div>
              <h2>No targets configured</h2>
              <p>Add your first endpoint to begin checking it while OPOSSUM is open.</p>
            </div>
          )}
          {groups.length > 0 && visibleChecks === 0 && (
            <div className="empty-state">
              <h2>Nothing matches these filters</h2>
              <p>Every check is hidden by the current search or filter selection.</p>
              <button className="button secondary" onClick={clearFilters}>
                <X size={14} /> Clear filters
              </button>
            </div>
          )}
        </div>
      </div>
      {selected && (
        <DetailPanel
          selected={selected}
          state={selectedState}
          settings={snapshot.settings}
          range={range}
          timeline={timeline}
          onRange={setRange}
          onClose={() => setSelected(undefined)}
          onCopy={copy}
        />
      )}
    </div>
  );
}
