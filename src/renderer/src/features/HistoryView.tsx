import { useEffect, useState } from 'react';
import { ArrowRight, CalendarClock, Trash2 } from 'lucide-react';
import type { TargetConfig } from '@core/config';
import type { SessionSummary, TimelineResult } from '@core/models';
import type { HistoricalDefinition, PurgePreview } from '@shared/contracts';
import { Modal } from '../components/Modal';
import { Timeline } from '../components/Timeline';

function duration(session: SessionSummary): string {
  const end = session.endedAt ?? session.inferredEndAt ?? new Date().toISOString();
  const seconds = Math.max(
    0,
    (new Date(end).getTime() - new Date(session.startedAt).getTime()) / 1000,
  );
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

export function HistoryView({
  targets,
  onOpenData,
  onError,
  onNotice,
}: {
  targets: TargetConfig[];
  onOpenData(): void;
  onError(message: string): void;
  onNotice(message: string): void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PurgePreview>();
  const [deleting, setDeleting] = useState(false);
  const [deletedDefinitions, setDeletedDefinitions] = useState<HistoricalDefinition[]>([]);
  const [inspectSessionId, setInspectSessionId] = useState('');
  const [inspectTargetId, setInspectTargetId] = useState('');
  const [inspectCheckId, setInspectCheckId] = useState('');
  const [timeline, setTimeline] = useState<TimelineResult>();
  const load = (): void => {
    window.opossum
      .getSessions({ limit: 500 })
      .then(setSessions)
      .catch((error: unknown) => onError(describe(error)));
    window.opossum
      .listHistoricalDefinitions()
      .then(setDeletedDefinitions)
      .catch((error: unknown) => onError(describe(error)));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!inspectSessionId || !inspectTargetId) {
      setTimeline(undefined);
      return;
    }
    let alive = true;
    window.opossum
      .getTimeline({
        targetId: inspectTargetId,
        ...(inspectCheckId ? { checkId: inspectCheckId } : {}),
        range: 'all',
        sessionId: inspectSessionId,
      })
      .then((value) => alive && setTimeline(value))
      .catch((error: unknown) => alive && onError(describe(error)));
    return () => {
      alive = false;
    };
  }, [inspectSessionId, inspectTargetId, inspectCheckId, onError]);
  const inspectTarget = targets.find((target) => target.id === inspectTargetId);
  const requestDelete = async (): Promise<void> => {
    try {
      setPreview(await window.opossum.previewHistoryPurge({ sessionIds: [...selected] }));
    } catch (error) {
      onError(describe(error));
    }
  };
  const confirmDelete = async (): Promise<void> => {
    setDeleting(true);
    try {
      const summary = await window.opossum.purgeHistory({ sessionIds: [...selected] });
      onNotice(
        `Removed ${summary.sessionsRemoved} session${summary.sessionsRemoved === 1 ? '' : 's'} and ${summary.intervalsRemoved} status intervals`,
      );
      setSelected(new Set());
      setPreview(undefined);
      load();
    } catch (error) {
      onError(describe(error));
    } finally {
      setDeleting(false);
    }
  };
  const toggleSelected = (id: string, checked: boolean): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <div className="workspace padded">
      <div className="page-heading">
        <div>
          <p className="eyebrow">History</p>
          <h1>Monitoring sessions</h1>
          <p>Only periods when OPOSSUM was open are represented as observed endpoint status.</p>
        </div>
        {selected.size > 0 && (
          <button className="button danger-button" onClick={() => void requestDelete()}>
            <Trash2 size={16} /> Delete {selected.size} selected
          </button>
        )}
      </div>
      <div className="history-list">
        <div className="history-head">
          <span></span>
          <span>Session</span>
          <span>Ending</span>
          <span>Monitored</span>
          <span>Status intervals</span>
        </div>
        {sessions.map((session, index) => {
          const isCurrent = index === 0 && !session.endedAt;
          const label = isCurrent
            ? 'Current session'
            : new Date(session.startedAt).toLocaleString();
          return (
            <div
              className={`history-row ${inspectSessionId === session.id ? 'focused' : ''}`}
              key={session.id}
            >
              <button
                type="button"
                className="row-select"
                aria-label={`Inspect ${label}`}
                aria-pressed={inspectSessionId === session.id}
                onClick={() => setInspectSessionId(session.id)}
              />
              <span className="row-checkbox">
                <input
                  type="checkbox"
                  aria-label={`Select ${label} for deletion`}
                  disabled={!session.endedAt}
                  checked={selected.has(session.id)}
                  onChange={(event) => toggleSelected(session.id, event.target.checked)}
                />
              </span>
              <span>
                <strong>{label}</strong>
                <code>{session.id.slice(0, 8)}</code>
              </span>
              <span
                className={!session.endedAt ? 'live' : session.cleanShutdown ? 'clean' : 'unclean'}
              >
                {session.endedAt
                  ? session.cleanShutdown
                    ? 'Clean shutdown'
                    : 'Unclean ending'
                  : 'Monitoring now'}
                <small>
                  {session.endedAt
                    ? new Date(session.endedAt).toLocaleString()
                    : `Heartbeat ${new Date(session.lastHeartbeatAt).toLocaleTimeString()}`}
                </small>
              </span>
              <span className="tabular">{duration(session)}</span>
              <span className="session-counts">
                <span className="split" aria-hidden="true">
                  {session.passCount + session.failCount > 0 && (
                    <>
                      <i
                        className="pass-text"
                        style={{
                          width: `${(session.passCount / (session.passCount + session.failCount)) * 100}%`,
                        }}
                      />
                      <i
                        className="fail-text"
                        style={{
                          width: `${(session.failCount / (session.passCount + session.failCount)) * 100}%`,
                        }}
                      />
                    </>
                  )}
                </span>
                <span>
                  <b className="pass-text">{session.passCount} pass</b>
                  <b className="fail-text">{session.failCount} fail</b>
                </span>
              </span>
            </div>
          );
        })}
        {sessions.length === 0 && (
          <div className="empty-state">
            <CalendarClock size={30} />
            <h2>No sessions retained</h2>
            <p>Monitoring history will appear here after checks run.</p>
          </div>
        )}
      </div>
      <button className="link-button" style={{ marginTop: 14 }} onClick={onOpenData}>
        Retention settings, storage statistics, and purge tools <ArrowRight size={14} />
      </button>
      {sessions.length > 0 && targets.length > 0 && (
        <section className="session-inspector settings-card">
          <div className="section-heading">
            <div>
              <h2>Inspect a session timeline</h2>
              <p>Select a session above, then choose a target or individual check.</p>
            </div>
          </div>
          <div className="session-inspector-controls">
            <label>
              <span>Session</span>
              <select
                value={inspectSessionId}
                onChange={(event) => setInspectSessionId(event.target.value)}
              >
                <option value="">Choose a session…</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.endedAt
                      ? new Date(session.startedAt).toLocaleString()
                      : 'Current session'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Target</span>
              <select
                value={inspectTargetId}
                onChange={(event) => {
                  setInspectTargetId(event.target.value);
                  setInspectCheckId('');
                }}
              >
                <option value="">Choose a target…</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Check (optional)</span>
              <select
                value={inspectCheckId}
                disabled={!inspectTarget}
                onChange={(event) => setInspectCheckId(event.target.value)}
              >
                <option value="">Aggregate target status</option>
                {inspectTarget?.checks.map((check) => (
                  <option key={check.id} value={check.id}>
                    {check.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {inspectSessionId && inspectTargetId && <Timeline timeline={timeline} />}
        </section>
      )}
      {deletedDefinitions.length > 0 && (
        <section className="deleted-definitions">
          <div>
            <h2>Deleted definitions retained with history</h2>
            <p>
              These identities remain available so earlier session results keep their original
              context.
            </p>
          </div>
          {deletedDefinitions.map((target) => (
            <article key={target.targetId}>
              <span className="deleted-pill">
                {target.deleted ? 'Deleted target' : 'Contains deleted checks'}
              </span>
              <strong>{target.name}</strong>
              <code>
                {target.targetId} · {target.host}
              </code>
              <div>
                {target.checks
                  .filter((check) => check.deleted || target.deleted)
                  .map((check) => (
                    <span key={check.checkId}>
                      {check.name}{' '}
                      <small>
                        {check.type.toUpperCase()} · {check.checkId}
                      </small>
                      {check.deleted && <em>Deleted</em>}
                    </span>
                  ))}
              </div>
            </article>
          ))}
        </section>
      )}
      <Modal
        open={Boolean(preview)}
        onOpenChange={(value) => !value && setPreview(undefined)}
        title="Delete selected sessions?"
        description="This removes status history only. Targets, checks, settings, and last-known results are preserved."
      >
        <div className="impact-preview">
          <strong>{preview?.sessionCount ?? 0}</strong>
          <span>sessions affected</span>
          <strong>{preview?.intervalCount ?? 0}</strong>
          <span>status intervals affected</span>
        </div>
        <div className="modal-actions">
          <button className="button ghost" onClick={() => setPreview(undefined)}>
            Cancel
          </button>
          <button
            className="button danger-button"
            disabled={deleting}
            onClick={() => void confirmDelete()}
          >
            {deleting ? 'Deleting…' : 'Delete history'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}
