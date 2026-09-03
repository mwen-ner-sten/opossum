import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CalendarClock,
  Database,
  Download,
  History,
  Moon,
  Pause,
  Play,
  Plus,
  Settings,
  Sun,
  Upload,
} from 'lucide-react';
import type { TargetConfig } from '@core/config';
import type { AppSnapshot } from '@shared/contracts';
import type { ImportPreview } from '@shared/contracts';
import { Brand } from './components/Brand';
import { Modal } from './components/Modal';
import { ConfigurationView } from './features/ConfigurationView';
import { DataView } from './features/DataView';
import { HistoryView } from './features/HistoryView';
import { MonitorView } from './features/MonitorView';
import { TargetEditor } from './features/TargetEditor';

type View = 'monitor' | 'history' | 'configuration' | 'data';

function isImportPreview(value: unknown): value is ImportPreview {
  return Boolean(value && typeof value === 'object' && 'newTargets' in value);
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [view, setView] = useState<View>('monitor');
  const [editor, setEditor] = useState<{ target?: TargetConfig; duplicate?: boolean }>();
  const [deleting, setDeleting] = useState<TargetConfig>();
  const [importPreview, setImportPreview] = useState<ImportPreview>();
  const [adjacentPrompt, setAdjacentPrompt] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') ?? 'system');

  const load = useCallback(async () => {
    try {
      setSnapshot(await window.opossum.getSnapshot());
      setError('');
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'OPOSSUM could not load its local state.',
      );
    }
  }, []);
  useEffect(() => {
    void load();
    const offStatus = window.opossum.onStatusChanged((states) =>
      setSnapshot((current) => (current ? { ...current, states } : current)),
    );
    const offConfig = window.opossum.onConfigurationChanged(() => void load());
    const offMaintenance = window.opossum.onMaintenanceChanged((summary) => {
      setNotice(`${summary.reason.replaceAll('-', ' ')} completed`);
      window.setTimeout(() => setNotice(''), 3500);
    });
    return () => {
      offStatus();
      offConfig();
      offMaintenance();
    };
  }, [load]);
  useEffect(() => {
    localStorage.setItem('theme', theme);
    const dark =
      theme === 'dark' ||
      (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [theme]);
  useEffect(() => {
    if (
      snapshot?.targets.length === 0 &&
      snapshot.adjacentConfigurationPath &&
      !sessionStorage.getItem('adjacent-config-seen')
    ) {
      sessionStorage.setItem('adjacent-config-seen', 'true');
      setAdjacentPrompt(true);
    }
  }, [snapshot]);

  const counts = useMemo(() => {
    const value = { PASS: 0, FAIL: 0, CHECKING: 0, UNKNOWN: 0, PAUSED: 0 };
    snapshot?.states.forEach((state) => {
      value[state.status] += 1;
    });
    return value;
  }, [snapshot?.states]);
  const importConfig = async (): Promise<void> => {
    setBusy('import');
    setError('');
    try {
      const result = await window.opossum.importConfiguration({ previewOnly: true });
      if (isImportPreview(result)) setImportPreview(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Configuration could not be imported.');
    } finally {
      setBusy('');
    }
  };
  const previewAdjacent = async (): Promise<void> => {
    if (!snapshot?.adjacentConfigurationPath) return;
    setAdjacentPrompt(false);
    try {
      const result = await window.opossum.importConfiguration({
        filePath: snapshot.adjacentConfigurationPath,
        previewOnly: true,
      });
      if (isImportPreview(result)) setImportPreview(result);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Adjacent configuration could not be opened.',
      );
    }
  };
  const confirmImport = async (mode: 'replace' | 'add-only'): Promise<void> => {
    if (!importPreview) return;
    setBusy('import-confirm');
    try {
      await window.opossum.importConfiguration({ filePath: importPreview.filePath, mode });
      setImportPreview(undefined);
      setNotice('Configuration imported');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Configuration could not be imported.');
    } finally {
      setBusy('');
    }
  };
  const exportConfig = async (): Promise<void> => {
    setBusy('export');
    try {
      const path = await window.opossum.exportConfiguration({});
      if (path) setNotice(`Configuration exported to ${path}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Configuration could not be exported.');
    } finally {
      setBusy('');
    }
  };
  const toggleAll = async (): Promise<void> => {
    if (!snapshot) return;
    if (snapshot.pausedAll) await window.opossum.resumeAll();
    else await window.opossum.pauseAll();
    setSnapshot({ ...snapshot, pausedAll: !snapshot.pausedAll });
  };
  const deleteTarget = async (): Promise<void> => {
    if (!deleting) return;
    setBusy('delete');
    try {
      await window.opossum.deleteTarget(deleting.id);
      setDeleting(undefined);
      setNotice('Target deleted; its history remains available.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Target could not be deleted.');
    } finally {
      setBusy('');
    }
  };

  if (!snapshot)
    return (
      <main className="boot-screen">
        <Brand />
        <div className="loading-line" />
        <p>{error || 'Opening local database and restoring configuration…'}</p>
        {error && (
          <button className="button primary" onClick={() => void load()}>
            Try again
          </button>
        )}
      </main>
    );
  const firstRun = snapshot.targets.length === 0 && view === 'monitor';
  return (
    <div className="app-shell">
      <aside className="rail">
        <Brand />
        <nav aria-label="Primary navigation">
          <button className={view === 'monitor' ? 'active' : ''} onClick={() => setView('monitor')}>
            <Activity size={18} />
            <span>Monitor</span>
            {counts.FAIL > 0 && <b>{counts.FAIL}</b>}
          </button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            <History size={18} />
            <span>History</span>
          </button>
          <button
            className={view === 'configuration' ? 'active' : ''}
            onClick={() => setView('configuration')}
          >
            <Settings size={18} />
            <span>Configuration</span>
          </button>
          <button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>
            <Database size={18} />
            <span>Data & history</span>
          </button>
        </nav>
        <div className="rail-footer">
          <div className="theme-switch" aria-label="Theme">
            <button
              className={theme === 'light' ? 'active' : ''}
              onClick={() => setTheme('light')}
              aria-label="Light theme"
            >
              <Sun size={15} />
            </button>
            <button
              className={theme === 'system' ? 'active' : ''}
              onClick={() => setTheme('system')}
              aria-label="System theme"
            >
              A
            </button>
            <button
              className={theme === 'dark' ? 'active' : ''}
              onClick={() => setTheme('dark')}
              aria-label="Dark theme"
            >
              <Moon size={15} />
            </button>
          </div>
          <small>v0.1.0 · MIT</small>
        </div>
      </aside>
      <main className="app-main">
        <header className="topbar">
          <div className="status-summary" aria-label="Check status counts">
            {Object.entries(counts).map(([status, count]) => (
              <div key={status} className={`summary-${status.toLowerCase()}`}>
                <span>{count}</span>
                <small>{status.toLowerCase()}</small>
              </div>
            ))}
          </div>
          <div className="session-health">
            <span className="health-dot" /> Local database healthy
            <small>
              Session started {new Date(snapshot.session.startedAt).toLocaleTimeString()}
            </small>
          </div>
          <div className="top-actions">
            <button
              className="button ghost"
              disabled={busy === 'import'}
              onClick={() => void importConfig()}
            >
              <Upload size={15} /> Import
            </button>
            <button
              className="button ghost"
              disabled={busy === 'export'}
              onClick={() => void exportConfig()}
            >
              <Download size={15} /> Export
            </button>
            <button className="button secondary" onClick={() => void toggleAll()}>
              {snapshot.pausedAll ? <Play size={15} /> : <Pause size={15} />}{' '}
              {snapshot.pausedAll ? 'Resume all' : 'Pause all'}
            </button>
            <button className="button primary" onClick={() => void window.opossum.runAll()}>
              <Activity size={15} /> Run all
            </button>
          </div>
        </header>
        {firstRun ? (
          <section className="first-run">
            <div className="first-run-art">
              <Brand compact />
              <span className="pulse-ring one" />
              <span className="pulse-ring two" />
            </div>
            <p className="eyebrow">Welcome to OPOSSUM</p>
            <h1>
              Know what is reachable,
              <br />
              right when you need to.
            </h1>
            <p>
              OPOSSUM checks hosts, TCP ports, and web applications while this window is open. No
              service, cloud account, or internet connection is required.
            </p>
            <div className="first-actions">
              <button className="button primary large" onClick={() => setEditor({})}>
                <Plus size={17} /> Add first target
              </button>
              <button className="button secondary large" onClick={() => void importConfig()}>
                <Upload size={17} /> Import configuration
              </button>
              <button className="button ghost large" onClick={() => setEditor({})}>
                <CalendarClock size={17} /> Guided setup
              </button>
            </div>
            <div className="first-features">
              <span>
                <b>01</b> Reachability
              </span>
              <span>
                <b>02</b> Port access
              </span>
              <span>
                <b>03</b> Web response
              </span>
            </div>
          </section>
        ) : view === 'monitor' ? (
          <MonitorView
            snapshot={snapshot}
            onEdit={(target) => setEditor({ target })}
            onDuplicate={(target) => setEditor({ target, duplicate: true })}
            onDelete={setDeleting}
          />
        ) : view === 'history' ? (
          <HistoryView targets={snapshot.targets} />
        ) : view === 'configuration' ? (
          <ConfigurationView
            targets={snapshot.targets}
            onAdd={() => setEditor({})}
            onEdit={(target) => setEditor({ target })}
            onDuplicate={(target) => setEditor({ target, duplicate: true })}
            onDelete={setDeleting}
            onToggle={(target) =>
              void window.opossum.saveTarget({ ...target, enabled: !target.enabled })
            }
          />
        ) : (
          <DataView
            settings={snapshot.settings}
            targets={snapshot.targets}
            onSettingsSaved={() => void load()}
          />
        )}
      </main>
      <TargetEditor
        open={Boolean(editor)}
        target={editor?.target}
        duplicate={editor?.duplicate}
        onClose={() => setEditor(undefined)}
        onSaved={() => void load()}
      />
      <Modal
        open={adjacentPrompt}
        onOpenChange={setAdjacentPrompt}
        title="Configuration found beside OPOSSUM"
        description="An opossum.yaml file is available beside the portable executable. It will not be read again after import."
      >
        <div className="confirm-callout adjacent">
          <strong>{snapshot.adjacentConfigurationPath}</strong>
          <span>Preview the file before copying its configuration into the local database.</span>
        </div>
        <div className="modal-actions">
          <button className="button ghost" onClick={() => setAdjacentPrompt(false)}>
            Not now
          </button>
          <button className="button primary" onClick={() => void previewAdjacent()}>
            Preview import
          </button>
        </div>
      </Modal>
      <Modal
        open={Boolean(deleting)}
        onOpenChange={(value) => !value && setDeleting(undefined)}
        title={`Delete ${deleting?.name ?? 'target'}?`}
        description="The target and its checks will stop running. Existing monitoring history remains viewable and can be purged separately."
      >
        <div className="confirm-callout">
          <strong>{deleting?.checks.length ?? 0} checks will be disabled</strong>
          <span>The stable target identity is retained with its history.</span>
        </div>
        <div className="modal-actions">
          <button className="button ghost" onClick={() => setDeleting(undefined)}>
            Cancel
          </button>
          <button
            className="button danger-button"
            disabled={busy === 'delete'}
            onClick={() => void deleteTarget()}
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete target'}
          </button>
        </div>
      </Modal>
      <Modal
        open={Boolean(importPreview)}
        onOpenChange={(value) => !value && setImportPreview(undefined)}
        title="Import configuration"
        description="Review how this YAML file matches the local database before applying it."
      >
        <div className="import-grid">
          <div>
            <strong>{importPreview?.newTargets ?? 0}</strong>
            <span>new targets</span>
          </div>
          <div>
            <strong>{importPreview?.matchingTargets ?? 0}</strong>
            <span>matching targets</span>
          </div>
          <div>
            <strong>{importPreview?.newChecks ?? 0}</strong>
            <span>new checks</span>
          </div>
          <div>
            <strong>{importPreview?.matchingChecks ?? 0}</strong>
            <span>matching checks</span>
          </div>
        </div>
        {importPreview?.conflicts.length ? (
          <div className="warning-box">
            {importPreview.conflicts.map((conflict) => (
              <div key={`${conflict.kind}-${conflict.targetId}-${conflict.checkId}`}>
                {conflict.targetId}
                {conflict.checkId ? ` / ${conflict.checkId}` : ''}: {conflict.reason}
              </div>
            ))}
          </div>
        ) : null}
        <div className="import-modes">
          <button
            className="mode-card"
            disabled={busy === 'import-confirm'}
            onClick={() => void confirmImport('replace')}
          >
            <strong>Replace active configuration</strong>
            <span>
              Update matching IDs, add new items, and soft-delete active items absent from this
              file.
            </span>
          </button>
          <button
            className="mode-card"
            disabled={busy === 'import-confirm'}
            onClick={() => void confirmImport('add-only')}
          >
            <strong>Add only new items</strong>
            <span>
              Add targets with new IDs and leave every existing or deleted identity untouched.
            </span>
          </button>
        </div>
        <div className="modal-actions">
          <button className="button ghost" onClick={() => setImportPreview(undefined)}>
            Cancel
          </button>
        </div>
      </Modal>
      {error && (
        <div className="toast toast-error" role="alert">
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
          {error}
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
