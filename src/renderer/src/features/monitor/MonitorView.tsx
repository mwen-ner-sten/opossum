import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  LayoutList,
  Search,
  Server,
  X,
} from 'lucide-react';
import type { CheckConfig, TargetConfig } from '@core/config';
import { type CheckStatus, type LiveCheckState, type TimelineResult } from '@core/models';
import type { AppSnapshot, TimelineRange } from '@shared/contracts';
import { missingTemplateVariables } from '@core/templates';
import { checkVerdict, summarizeVerdicts, verdictReport, type Verdict } from '@core/verdict';
import { DetailPanel, type SelectedCheck } from './DetailPanel';
import {
  byHealth,
  countLevels,
  foldHealthy,
  HEALTH_ORDER,
  targetHealth,
  worstLevel,
} from './board';
import { keyFor } from './format';
import { TargetBlock } from './TargetBlock';
import { VerdictBar } from './VerdictBar';

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
  onOpenData,
  onError,
  onResumeAll,
}: {
  snapshot: AppSnapshot;
  statusFilter: string;
  onStatusFilter(status: string): void;
  onEdit(target: TargetConfig): void;
  onDuplicate(target: TargetConfig): void;
  onDelete(target: TargetConfig): void;
  onNotice(message: string): void;
  onOpenData(): void;
  onError(message: string): void;
  onResumeAll(): Promise<void>;
}) {
  const [search, setSearch] = useStoredValue('filter.search', '');
  const [typeFilter, setTypeFilter] = useStoredValue('filter.type', 'all');
  const [groupFilter, setGroupFilter] = useStoredValue('filter.group', 'all');
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('collapsedGroups') ?? '[]') as string[]),
  );
  const [healthyShown, setHealthyShown] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('healthyShownGroups') ?? '[]') as string[]),
  );
  // Targets start as one line each; expanding one shows its check rows.
  const [expandedTargets, setExpandedTargets] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('expandedTargets') ?? '[]') as string[]),
  );
  const [verdictFilter, setVerdictFilter] = useState<Verdict | 'all'>('all');
  const [selection, setSelected] = useState<SelectedCheck>();
  const selectedTarget = snapshot.targets.find((target) => target.id === selection?.target.id);
  const selected = useMemo(
    () =>
      selection && selectedTarget
        ? { target: selectedTarget, checkId: selection.checkId }
        : undefined,
    [selection, selectedTarget],
  );
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
      const group = result.get(name);
      if (group) group.push(target);
      else result.set(name, [target]);
    }
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [snapshot.targets]);

  useEffect(() => {
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed]));
  }, [collapsed]);
  useEffect(() => {
    // Replaced by expandedTargets when targets became one line each by default.
    localStorage.removeItem('collapsedTargets');
  }, []);
  useEffect(() => {
    localStorage.setItem('expandedTargets', JSON.stringify([...expandedTargets]));
  }, [expandedTargets]);
  useEffect(() => {
    localStorage.setItem('healthyShownGroups', JSON.stringify([...healthyShown]));
  }, [healthyShown]);
  const toggleHealthy = (group: string): void =>
    setHealthyShown((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const viewMenu = useRef<HTMLDetailsElement>(null);
  // A search or status filter is a request to look closer, so matching targets open up.
  // Collapsing one during that search is remembered only until the filter is cleared.
  const autoExpand =
    search !== '' || statusFilter !== 'all' || typeFilter !== 'all' || verdictFilter !== 'all';
  const [collapsedWhileFiltering, setCollapsedWhileFiltering] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    if (!autoExpand) setCollapsedWhileFiltering(new Set());
  }, [autoExpand]);
  const isExpanded = (id: string): boolean =>
    autoExpand ? !collapsedWhileFiltering.has(id) : expandedTargets.has(id);
  const setTargetsExpanded = (ids: readonly string[], expand: boolean): void => {
    const update = (current: Set<string>, add: boolean): Set<string> => {
      const next = new Set(current);
      for (const id of ids)
        if (add) next.add(id);
        else next.delete(id);
      return next;
    };
    if (autoExpand) setCollapsedWhileFiltering((current) => update(current, !expand));
    else setExpandedTargets((current) => update(current, expand));
    if (viewMenu.current) viewMenu.current.open = false;
  };
  const toggleTarget = (id: string): void => setTargetsExpanded([id], !isExpanded(id));
  // Bulk expand/collapse: with hundreds of hosts, per-row clicking is not workable.
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
      (verdictFilter === 'all' || checkVerdict(stateOf(target, check)) === verdictFilter) &&
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
    search !== '' ||
    statusFilter !== 'all' ||
    typeFilter !== 'all' ||
    groupFilter !== 'all' ||
    verdictFilter !== 'all';
  const clearFilters = (): void => {
    setSearch('');
    setTypeFilter('all');
    setGroupFilter('all');
    setVerdictFilter('all');
    onStatusFilter('all');
  };
  const verdicts = useMemo(() => summarizeVerdicts(snapshot.states), [snapshot.states]);
  const copyVerdict = (): Promise<void> =>
    copy(
      verdictReport(
        snapshot.targets.flatMap((target) =>
          target.checks.map((check) => ({ target, check, state: stateOf(target, check) })),
        ),
        new Date().toISOString(),
      ),
      'Verdict',
    );
  const totalChecks = snapshot.targets.reduce((sum, target) => sum + target.checks.length, 0);
  const incompleteTargets = useMemo(
    () =>
      snapshot.targets.flatMap((target) => {
        const missing = missingTemplateVariables(
          target,
          snapshot.templates.find((item) => item.id === target.template),
        );
        return missing.length ? [{ target, missing }] : [];
      }),
    [snapshot.targets, snapshot.templates],
  );
  const board = groups.flatMap(([group, targets]) => {
    const rows = targets.flatMap((target) => {
      const checks = orderedChecks(target);
      if (checks.length === 0) return [];
      const states = checks.map((check) => stateOf(target, check));
      return [{ target, checks, states, health: targetHealth(states) }];
    });
    return rows.length
      ? [{ group, rows, level: worstLevel(rows.map((row) => row.health.level)) }]
      : [];
  });
  const groupNames = groups.map(([group]) => group);
  const allTargetIds = snapshot.targets.map((target) => target.id);
  const visibleChecks = snapshot.targets.reduce(
    (sum, target) => sum + target.checks.filter((check) => visible(target, check)).length,
    0,
  );

  return (
    <div className={`workspace monitor-workspace ${selected ? 'with-details' : ''}`}>
      <div className="workspace-main">
        {incompleteTargets.length > 0 && (
          <section className="configuration-needs" aria-label="Incomplete targets">
            <h2>
              Finish setting up {incompleteTargets.length} target
              {incompleteTargets.length === 1 ? '' : 's'}
            </h2>
            <p>Some inherited checks cannot run until these values are provided.</p>
            {incompleteTargets.map(({ target, missing }) => (
              <button key={target.id} className="button secondary" onClick={() => onEdit(target)}>
                Configure {target.name} — needs {missing.join(', ')}
              </button>
            ))}
          </section>
        )}
        <VerdictBar
          summary={verdicts}
          activeFilter={verdictFilter}
          onFilter={setVerdictFilter}
          onCopy={() => void copyVerdict().catch(() => onError('Could not copy the verdict'))}
        />
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
              <button role="menuitem" onClick={() => setTargetsExpanded(allTargetIds, true)}>
                Expand all targets
              </button>
              <button role="menuitem" onClick={() => setTargetsExpanded(allTargetIds, false)}>
                Collapse all targets
              </button>
              <hr />
              <button
                role="menuitem"
                onClick={() => {
                  setGroupsCollapsed(groupNames, false);
                  setHealthyShown(new Set(groupNames));
                  setTargetsExpanded(allTargetIds, true);
                }}
              >
                Expand everything
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setGroupsCollapsed(groupNames, true);
                  setHealthyShown(new Set());
                  setTargetsExpanded(allTargetIds, false);
                }}
              >
                Collapse everything
              </button>
              <hr />
              <button
                role="menuitem"
                onClick={() => {
                  setHealthyShown(new Set(groupNames));
                  if (viewMenu.current) viewMenu.current.open = false;
                }}
              >
                Show healthy targets
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setHealthyShown(new Set());
                  if (viewMenu.current) viewMenu.current.open = false;
                }}
              >
                Fold healthy targets
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
        <div className="target-groups">
          {byHealth(board, (entry) => entry.level).map(({ group, rows, level }) => {
            const isCollapsed = collapsed.has(group);
            const groupIds = rows.map((row) => row.target.id);
            const anyExpanded = groupIds.some(isExpanded);
            const levels = countLevels(rows.map((row) => row.health.level));
            // Healthy targets fold into one line so problems stay on screen; a search or
            // filter shows every match.
            const showHealthy = filtering || healthyShown.has(group);
            const pinned = new Set(
              rows
                .map((row) => row.target.id)
                .filter((id) => isExpanded(id) || selected?.target.id === id),
            );
            const sorted = byHealth(rows, (row) => row.health.level);
            const { shown: problems, folded: healthy } = foldHealthy(
              sorted,
              (row) => row.health.level,
              (row) => row.target.id,
              pinned,
            );
            const shown = showHealthy ? sorted : problems;
            return (
              <section className={`target-group health-${level}`} key={group}>
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
                      {rows.length} target{rows.length === 1 ? '' : 's'} · {levels.text}
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
                      onClick={() => setTargetsExpanded(groupIds, !anyExpanded)}
                    >
                      {anyExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                    </button>
                  )}
                  <span className="group-bar" aria-hidden="true">
                    {HEALTH_ORDER.map((item) =>
                      levels.counts[item] > 0 ? (
                        <i
                          key={item}
                          className={`health-${item}`}
                          style={{ flexGrow: levels.counts[item] }}
                        />
                      ) : null,
                    )}
                  </span>
                </div>
                {!isCollapsed &&
                  shown.map(({ target, checks, states, health }) => (
                    <TargetBlock
                      key={target.id}
                      target={target}
                      checks={checks}
                      states={states}
                      health={health}
                      expanded={isExpanded(target.id)}
                      selectedCheckId={
                        selected?.target.id === target.id ? selected.checkId : undefined
                      }
                      missingVariables={missingTemplateVariables(
                        target,
                        snapshot.templates.find((item) => item.id === target.template),
                      )}
                      defaultTimeoutSeconds={snapshot.settings.default_timeout_seconds}
                      onToggle={() => toggleTarget(target.id)}
                      onSelectCheck={(checkId) => setSelected({ target, checkId })}
                      onEdit={() => onEdit(target)}
                      onDuplicate={() => onDuplicate(target)}
                      onDelete={() => onDelete(target)}
                    />
                  ))}
                {!isCollapsed && healthy.length > 0 && !filtering && (
                  <button
                    type="button"
                    className="healthy-fold"
                    aria-expanded={showHealthy}
                    onClick={() => toggleHealthy(group)}
                  >
                    {showHealthy ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    <span className="health-mark health-ok" aria-hidden="true" />
                    <strong>
                      {showHealthy ? 'Fold' : ''} {healthy.length} healthy target
                      {healthy.length === 1 ? '' : 's'}
                    </strong>
                    {!showHealthy && (
                      <small>{healthy.map((row) => row.target.name).join(', ')}</small>
                    )}
                  </button>
                )}
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
          {groups.length > 0 && totalChecks > 0 && visibleChecks === 0 && (
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
          pausedAll={snapshot.pausedAll}
          onEdit={() => onEdit(selected.target)}
          onOpenData={onOpenData}
          onDependency={(checkId) => setSelected({ target: selected.target, checkId })}
          onError={onError}
          onResumeAll={onResumeAll}
        />
      )}
    </div>
  );
}
