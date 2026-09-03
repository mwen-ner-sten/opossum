import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Database,
  Download,
  FileText,
  History,
  Laptop,
  Moon,
  Pause,
  Play,
  Plus,
  Settings,
  Sun,
  Upload,
} from 'lucide-react';
import type { CheckTemplate, TargetConfig } from '@core/config';
import type { AppSnapshot, ImportMode, ImportPreview, TableImportSource } from '@shared/contracts';
import { Brand } from './components/Brand';
import { Modal } from './components/Modal';
import { StatusStrip, type StatusCounts } from './components/StatusStrip';
import { ConfigurationView } from './features/ConfigurationView';
import { DataView } from './features/DataView';
import { HistoryView } from './features/HistoryView';
import { ImportBuilder } from './features/ImportBuilder';
import { MonitorView } from './features/monitor/MonitorView';
import { TargetEditor } from './features/TargetEditor';
import { TemplateEditor } from './features/TemplateEditor';
import { applyTheme, readStoredTheme, watchSystemTheme, type ThemePreference } from './theme';

type View = 'monitor' | 'history' | 'configuration' | 'data';
type ImportSource = { kind: 'file'; filePath: string } | { kind: 'example' };
const NOTICE_MS = 3_500;

function isImportPreview(value: unknown): value is ImportPreview {
  return Boolean(value && typeof value === 'object' && 'newTargets' in value);
}
function isTableSource(value: unknown): value is TableImportSource {
  return Boolean(
    value && typeof value === 'object' && (value as { kind?: string }).kind === 'table',
  );
}

function displayError(error: unknown): string {
  if (!(error instanceof Error)) return 'An unexpected error occurred.';
  const details = (error as Error & { details?: unknown }).details;
  if (!Array.isArray(details)) return error.message;
  const issues = details
    .slice(0, 8)
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const issue = item as { path?: unknown; message?: unknown };
      const path = typeof issue.path === 'string' && issue.path ? issue.path : 'configuration';
      const message = typeof issue.message === 'string' ? issue.message : 'invalid value';
      return `${path}: ${message}`;
    })
    .filter(Boolean);
  return issues.length ? `${error.message}\n${issues.join('\n')}` : error.message;
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [view, setView] = useState<View>('monitor');
  const [editor, setEditor] = useState<{ target?: TargetConfig; duplicate?: boolean }>();
  const [deleting, setDeleting] = useState<TargetConfig>();
  const [importPreview, setImportPreview] = useState<{
    preview: ImportPreview;
    source: ImportSource;
  }>();
  const [adjacentPrompt, setAdjacentPrompt] = useState(false);
  const [templateEditor, setTemplateEditor] = useState<{ template?: CheckTemplate }>();
  const [deletingTemplate, setDeletingTemplate] = useState<CheckTemplate>();
  const [tableImport, setTableImport] = useState<{ source: TableImportSource; text?: string }>();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState<ThemePreference>(readStoredTheme);
  const [statusFilter, setStatusFilter] = useState(
    () => localStorage.getItem('filter.status') ?? 'all',
  );
  useEffect(() => localStorage.setItem('filter.status', statusFilter), [statusFilter]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(
      () => setNotice((current) => (current === message ? '' : current)),
      NOTICE_MS,
    );
  }, []);
  const showError = useCallback((message: string) => setError(message), []);

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
      if (summary.error)
        setError(`${summary.reason.replaceAll('-', ' ')} failed: ${summary.error}`);
      else showNotice(`${summary.reason.replaceAll('-', ' ')} completed`);
    });
    const offHealth = window.opossum.onHealthChanged((healthy) => {
      setSnapshot((current) => (current ? { ...current, databaseHealthy: healthy } : current));
      if (!healthy)
        setError('Database writes are failing. Results are shown live but may not be saved.');
    });
    return () => {
      offStatus();
      offConfig();
      offMaintenance();
      offHealth();
    };
  }, [load, showNotice]);
  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(() => theme);
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
    const value: StatusCounts = { PASS: 0, FAIL: 0, CHECKING: 0, UNKNOWN: 0, PAUSED: 0 };
    snapshot?.states.forEach((state) => {
      value[state.status] += 1;
    });
    return value;
  }, [snapshot?.states]);

  const previewImport = async (source?: ImportSource): Promise<void> => {
    setBusy('import');
    setError('');
    try {
      const options =
        source?.kind === 'example'
          ? { example: true, previewOnly: true }
          : source?.kind === 'file'
            ? { filePath: source.filePath, previewOnly: true }
            : { previewOnly: true };
      const result = await window.opossum.importConfiguration(options);
      if (isImportPreview(result))
        setImportPreview({
          preview: result,
          source: source ?? { kind: 'file', filePath: result.filePath },
        });
      else if (isTableSource(result)) setTableImport({ source: result });
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setBusy('');
    }
  };
  const confirmImport = async (mode: ImportMode): Promise<void> => {
    if (!importPreview) return;
    setBusy('import-confirm');
    try {
      const { source } = importPreview;
      await window.opossum.importConfiguration(
        source.kind === 'example' ? { example: true, mode } : { filePath: source.filePath, mode },
      );
      setImportPreview(undefined);
      showNotice(
        source.kind === 'example' ? 'Example configuration loaded' : 'Configuration imported',
      );
      await load();
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setBusy('');
    }
  };
  const openPasted = async (): Promise<void> => {
    setBusy('import');
    setError('');
    try {
      const result = await window.opossum.importConfiguration({ text: pasteText });
      if (isTableSource(result)) {
        setPasteOpen(false);
        setTableImport({ source: result, text: pasteText });
      }
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setBusy('');
    }
  };
  const deleteTemplate = async (): Promise<void> => {
    if (!deletingTemplate) return;
    setBusy('delete-template');
    try {
      await window.opossum.deleteTemplate(deletingTemplate.id);
      setDeletingTemplate(undefined);
      showNotice('Template deleted');
      await load();
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setBusy('');
    }
  };
  const exportConfig = async (): Promise<void> => {
    setBusy('export');
    try {
      const path = await window.opossum.exportConfiguration({});
      if (path) showNotice(`Configuration exported to ${path}`);
    } catch (caught) {
      setError(displayError(caught));
    } finally {
      setBusy('');
    }
  };
  const toggleAll = async (): Promise<void> => {
    if (!snapshot) return;
    try {
      if (snapshot.pausedAll) await window.opossum.resumeAll();
      else await window.opossum.pauseAll();
      setSnapshot({ ...snapshot, pausedAll: !snapshot.pausedAll });
    } catch (caught) {
      setError(displayError(caught));
    }
  };
  const deleteTarget = async (): Promise<void> => {
    if (!deleting) return;
    setBusy('delete');
    try {
      await window.opossum.deleteTarget(deleting.id);
      setDeleting(undefined);
      showNotice('Target deleted; its history remains available.');
      await load();
    } catch (caught) {
      setError(displayError(caught));
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
          <div
            className={`rail-health ${snapshot.databaseHealthy ? '' : 'unhealthy'}`}
            role="status"
          >
            <span className={`health-dot ${snapshot.databaseHealthy ? '' : 'unhealthy'}`} />
            <strong>
              {snapshot.databaseHealthy ? 'Local database healthy' : 'Database writes failing'}
            </strong>
            <small>Session since {new Date(snapshot.session.startedAt).toLocaleTimeString()}</small>
          </div>
          <div className="rail-meta">
            <small>v{snapshot.version} · MIT</small>
            <div className="theme-switch" aria-label="Theme">
              <button
                className={theme === 'light' ? 'active' : ''}
                onClick={() => setTheme('light')}
                aria-label="Light theme"
                title="Light theme"
              >
                <Sun size={14} />
              </button>
              <button
                className={theme === 'system' ? 'active' : ''}
                onClick={() => setTheme('system')}
                aria-label="System theme"
                title="Follow system theme"
              >
                <Laptop size={14} />
              </button>
              <button
                className={theme === 'dark' ? 'active' : ''}
                onClick={() => setTheme('dark')}
                aria-label="Dark theme"
                title="Dark theme"
              >
                <Moon size={14} />
              </button>
            </div>
          </div>
        </div>
      </aside>
      <main className="app-main">
        <header className="topbar">
          <StatusStrip
            counts={counts}
            activeFilter={view === 'monitor' ? statusFilter : 'all'}
            onFilter={(status) => {
              setStatusFilter(status);
              setView('monitor');
            }}
          />
          <div className="top-actions">
            <button
              className="button ghost"
              disabled={busy === 'import'}
              onClick={() => void previewImport()}
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
            <span className="divider" aria-hidden="true" />
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
            <div className="first-copy">
              <p className="eyebrow">Welcome to OPOSSUM</p>
              <h1>Know what is reachable, right when you need to.</h1>
              <p>
                OPOSSUM checks hosts, TCP ports, and web applications while this window is open. No
                service, cloud account, or internet connection is required.
              </p>
              <div className="first-actions">
                <button className="button primary large" onClick={() => setEditor({})}>
                  <Plus size={17} /> Add first target
                </button>
                <button className="button secondary large" onClick={() => void previewImport()}>
                  <Upload size={17} /> Import configuration
                </button>
                {snapshot.hasExampleConfiguration && (
                  <button
                    className="button ghost large"
                    onClick={() => void previewImport({ kind: 'example' })}
                  >
                    <FileText size={17} /> Load example configuration
                  </button>
                )}
              </div>
              <div className="first-features">
                <span>
                  <b>PING</b> Host reachability with round-trip time
                </span>
                <span>
                  <b>TCP</b> Port accepts connections within the timeout
                </span>
                <span>
                  <b>HTTP</b> Status code, body text, TLS, and redirects
                </span>
              </div>
            </div>
            <div className="first-art" aria-hidden="true">
              <span className="pulse-ring one" />
              <span className="pulse-ring two" />
              <span className="pulse-ring three" />
              <Brand compact />
            </div>
          </section>
        ) : view === 'monitor' ? (
          <MonitorView
            snapshot={snapshot}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            onEdit={(target) => setEditor({ target })}
            onDuplicate={(target) => setEditor({ target, duplicate: true })}
            onDelete={setDeleting}
            onNotice={showNotice}
          />
        ) : view === 'history' ? (
          <HistoryView
            targets={snapshot.targets}
            onOpenData={() => setView('data')}
            onError={showError}
            onNotice={showNotice}
          />
        ) : view === 'configuration' ? (
          <ConfigurationView
            targets={snapshot.targets}
            templates={snapshot.templates}
            onAdd={() => setEditor({})}
            onEdit={(target) => setEditor({ target })}
            onDuplicate={(target) => setEditor({ target, duplicate: true })}
            onDelete={setDeleting}
            onToggle={(target) =>
              void window.opossum
                .saveTarget({ ...target, enabled: !target.enabled })
                .catch((caught: unknown) => setError(displayError(caught)))
            }
            onNewTemplate={() => setTemplateEditor({})}
            onEditTemplate={(template) => setTemplateEditor({ template })}
            onDeleteTemplate={setDeletingTemplate}
            onImport={() => void previewImport()}
            onPaste={() => {
              setPasteText('');
              setPasteOpen(true);
            }}
          />
        ) : (
          <DataView
            settings={snapshot.settings}
            targets={snapshot.targets}
            onSettingsSaved={() => void load()}
            onError={showError}
            onNotice={showNotice}
          />
        )}
      </main>
      <TargetEditor
        open={Boolean(editor)}
        target={editor?.target}
        duplicate={editor?.duplicate}
        templates={snapshot.templates}
        onClose={() => setEditor(undefined)}
        onSaved={() => void load()}
      />
      <TemplateEditor
        open={Boolean(templateEditor)}
        template={templateEditor?.template}
        linkedCount={
          snapshot.targets.filter((target) => target.template === templateEditor?.template?.id)
            .length
        }
        onClose={() => setTemplateEditor(undefined)}
        onSaved={(message) => {
          showNotice(message);
          void load();
        }}
      />
      <ImportBuilder
        source={tableImport?.source}
        text={tableImport?.text}
        templates={snapshot.templates}
        onClose={() => setTableImport(undefined)}
        onImported={(message) => {
          showNotice(message);
          void load();
        }}
        onError={showError}
      />
      <Modal
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        title="Paste a host list"
        description="Paste rows copied from a spreadsheet or a CSV. The first line must be column headings such as name, host, group."
      >
        <textarea
          className="paste-area"
          aria-label="Pasted host list"
          placeholder={
            'name,host,group\nChicago BMS,10.20.30.40,Chicago\nDenver BMS,10.20.31.40,Denver'
          }
          value={pasteText}
          onChange={(event) => setPasteText(event.target.value)}
        />
        <div className="modal-actions">
          <button className="button ghost" onClick={() => setPasteOpen(false)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!pasteText.trim() || busy === 'import'}
            onClick={() => void openPasted()}
          >
            Open in import builder
          </button>
        </div>
      </Modal>
      <Modal
        open={Boolean(deletingTemplate)}
        onOpenChange={(value) => !value && setDeletingTemplate(undefined)}
        title={`Delete template ${deletingTemplate?.name ?? ''}?`}
        description="Templates can only be deleted when no target links to them. Targets that already inherited its checks are unaffected."
      >
        <div className="modal-actions">
          <button className="button ghost" onClick={() => setDeletingTemplate(undefined)}>
            Cancel
          </button>
          <button
            className="button danger-button"
            disabled={busy === 'delete-template'}
            onClick={() => void deleteTemplate()}
          >
            {busy === 'delete-template' ? 'Deleting…' : 'Delete template'}
          </button>
        </div>
      </Modal>
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
          <button
            className="button primary"
            onClick={() => {
              setAdjacentPrompt(false);
              if (snapshot.adjacentConfigurationPath)
                void previewImport({ kind: 'file', filePath: snapshot.adjacentConfigurationPath });
            }}
          >
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
        title={
          importPreview?.source.kind === 'example'
            ? 'Load example configuration'
            : 'Import configuration'
        }
        description={
          importPreview?.source.kind === 'example'
            ? 'The bundled example uses documentation addresses; edit the targets afterwards to point at your own hosts.'
            : 'Review how this YAML file matches the local database before applying it.'
        }
      >
        <div className="import-grid">
          <div>
            <strong>{importPreview?.preview.newTargets ?? 0}</strong>
            <span>new targets</span>
          </div>
          <div>
            <strong>{importPreview?.preview.matchingTargets ?? 0}</strong>
            <span>matching targets</span>
          </div>
          <div>
            <strong>{importPreview?.preview.newChecks ?? 0}</strong>
            <span>new checks</span>
          </div>
          <div>
            <strong>{importPreview?.preview.matchingChecks ?? 0}</strong>
            <span>matching checks</span>
          </div>
          {(importPreview?.preview.newTemplates ?? 0) +
            (importPreview?.preview.matchingTemplates ?? 0) >
            0 && (
            <>
              <div>
                <strong>{importPreview?.preview.newTemplates ?? 0}</strong>
                <span>new templates</span>
              </div>
              <div>
                <strong>{importPreview?.preview.matchingTemplates ?? 0}</strong>
                <span>matching templates</span>
              </div>
            </>
          )}
        </div>
        {importPreview?.preview.conflicts.length ? (
          <div className="warning-box">
            {importPreview.preview.conflicts.map((conflict) => (
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
