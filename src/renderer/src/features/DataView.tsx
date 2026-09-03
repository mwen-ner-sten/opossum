import { useEffect, useState } from 'react';
import { Database, ExternalLink, HardDrive, RefreshCw, Trash2, Wrench } from 'lucide-react';
import type { AppSettings, TargetConfig } from '@core/config';
import type { DatabaseStats, PurgeOptions, PurgePreview } from '@shared/contracts';
import { Modal } from '../components/Modal';

const bytes = (value: number): string =>
  value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} KiB`
    : `${(value / 1024 / 1024).toFixed(2)} MiB`;

export function DataView({
  settings: initialSettings,
  targets,
  onSettingsSaved,
}: {
  settings: AppSettings;
  targets: TargetConfig[];
  onSettingsSaved(): void;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [stats, setStats] = useState<DatabaseStats>();
  const [days, setDays] = useState(90);
  const [scopeTarget, setScopeTarget] = useState('');
  const [scopeCheck, setScopeCheck] = useState('');
  const [preview, setPreview] = useState<{
    options: PurgeOptions;
    value: PurgePreview;
    title: string;
  }>();
  const [busy, setBusy] = useState('');
  const load = (): void => {
    void window.opossum.getDatabaseStats().then(setStats);
  };
  useEffect(load, []);
  useEffect(() => setSettings(initialSettings), [initialSettings]);
  const selectedTarget = targets.find((target) => target.id === scopeTarget);
  const exceedsConfiguredSize = Boolean(
    stats &&
    settings.history_max_database_mb > 0 &&
    stats.totalBytes > settings.history_max_database_mb * 1024 * 1024,
  );
  const askPurge = async (options: PurgeOptions, title: string): Promise<void> =>
    setPreview({ options, title, value: await window.opossum.previewHistoryPurge(options) });
  const executePurge = async (): Promise<void> => {
    if (!preview) return;
    setBusy('purge');
    try {
      await window.opossum.purgeHistory(preview.options);
      setPreview(undefined);
      load();
    } finally {
      setBusy('');
    }
  };
  const optimize = async (fullVacuum: boolean): Promise<void> => {
    setBusy(fullVacuum ? 'vacuum' : 'optimize');
    try {
      await window.opossum.optimizeDatabase({ fullVacuum });
      load();
    } finally {
      setBusy('');
    }
  };
  const removeDeleted = async (): Promise<void> => {
    if (
      !window.confirm(
        'Remove soft-deleted targets and checks that have no remaining history or last-known state?',
      )
    )
      return;
    setBusy('remove-deleted');
    try {
      await window.opossum.removeUnusedDeletedItems();
      load();
    } finally {
      setBusy('');
    }
  };
  const saveSettings = async (): Promise<void> => {
    setBusy('settings');
    try {
      await window.opossum.saveSettings(settings);
      onSettingsSaved();
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="workspace padded data-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Data & history</p>
          <h1>Storage and retention</h1>
          <p>Inspect local storage, bound historical growth, and safely remove old observations.</p>
        </div>
        <button className="button secondary" onClick={load}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <HardDrive size={18} />
          <span>Total disk usage</span>
          <strong>{stats ? bytes(stats.totalBytes) : '—'}</strong>
          <small>
            Database {stats ? bytes(stats.databaseBytes) : '—'} · WAL{' '}
            {stats ? bytes(stats.walBytes) : '—'}
          </small>
        </div>
        <div className="stat-card">
          <Database size={18} />
          <span>Retained records</span>
          <strong>{stats?.intervalCount ?? '—'} intervals</strong>
          <small>
            {stats?.sessionCount ?? '—'} sessions · {stats?.targetCount ?? '—'} targets ·{' '}
            {stats?.checkCount ?? '—'} checks
          </small>
        </div>
        <div className="stat-card">
          <Wrench size={18} />
          <span>Last maintenance</span>
          <strong>
            {stats?.lastMaintenance
              ? stats.lastMaintenance.reason.replaceAll('-', ' ')
              : 'None yet'}
          </strong>
          <small>
            {stats?.lastMaintenance
              ? new Date(stats.lastMaintenance.endedAt).toLocaleString()
              : 'Maintenance runs at startup and every six hours'}
          </small>
        </div>
      </div>
      {exceedsConfiguredSize && (
        <div className="warning-box size-warning" role="status">
          Local database storage is above the configured size guard. OPOSSUM will remove only
          eligible closed history; it will never purge the current session to force the database
          below this limit.
        </div>
      )}
      <section className="settings-card">
        <div className="section-heading">
          <div>
            <h2>Monitoring defaults</h2>
            <p>New checks inherit these values unless they specify their own.</p>
          </div>
          <button
            className="button primary"
            disabled={busy === 'settings'}
            onClick={() => void saveSettings()}
          >
            {busy === 'settings' ? 'Saving…' : 'Save settings'}
          </button>
        </div>
        <div className="form-grid three">
          <label>
            <span>Default interval (seconds)</span>
            <input
              type="number"
              min="1"
              value={settings.default_interval_seconds}
              onChange={(event) =>
                setSettings({ ...settings, default_interval_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>Default timeout (seconds)</span>
            <input
              type="number"
              min="1"
              max="300"
              value={settings.default_timeout_seconds}
              onChange={(event) =>
                setSettings({ ...settings, default_timeout_seconds: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>Maximum concurrent checks</span>
            <input
              type="number"
              min="1"
              max="200"
              value={settings.max_concurrent_checks}
              onChange={(event) =>
                setSettings({ ...settings, max_concurrent_checks: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>History maximum age (days)</span>
            <input
              type="number"
              min="0"
              value={settings.history_max_age_days}
              onChange={(event) =>
                setSettings({ ...settings, history_max_age_days: Number(event.target.value) })
              }
            />
            <small>0 disables age purging</small>
          </label>
          <label>
            <span>Database size guard (MiB)</span>
            <input
              type="number"
              min="0"
              value={settings.history_max_database_mb}
              onChange={(event) =>
                setSettings({ ...settings, history_max_database_mb: Number(event.target.value) })
              }
            />
            <small>0 disables size enforcement</small>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.maintenance_on_startup}
              onChange={(event) =>
                setSettings({ ...settings, maintenance_on_startup: event.target.checked })
              }
            />
            <span>Run bounded maintenance at startup</span>
          </label>
        </div>
      </section>
      <div className="data-grid">
        <section className="settings-card">
          <h2>Purge history</h2>
          <p>
            Only closed sessions are eligible. Current monitoring and configuration are protected.
          </p>
          <div className="inline-form">
            <label>
              <span>Older than</span>
              <input
                type="number"
                min="1"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              />
            </label>
            <button
              className="button secondary"
              onClick={() =>
                void askPurge(
                  { before: new Date(Date.now() - days * 86_400_000).toISOString() },
                  `Purge history older than ${days} days?`,
                )
              }
            >
              Preview purge
            </button>
          </div>
          <div className="scope-form">
            <label>
              <span>Selected target</span>
              <select
                value={scopeTarget}
                onChange={(event) => {
                  setScopeTarget(event.target.value);
                  setScopeCheck('');
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
              <span>Selected check (optional)</span>
              <select
                value={scopeCheck}
                disabled={!selectedTarget}
                onChange={(event) => setScopeCheck(event.target.value)}
              >
                <option value="">All target checks</option>
                {selectedTarget?.checks.map((check) => (
                  <option key={check.id} value={check.id}>
                    {check.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={!scopeTarget}
              onClick={() =>
                void askPurge(
                  { targetId: scopeTarget, ...(scopeCheck ? { checkId: scopeCheck } : {}) },
                  'Purge history for this selection?',
                )
              }
            >
              Preview scoped purge
            </button>
          </div>
          <button
            className="button danger-button full"
            onClick={() => void askPurge({ all: true }, 'Clear all retained history?')}
          >
            <Trash2 size={15} /> Clear all history
          </button>
        </section>
        <section className="settings-card">
          <h2>Database tools</h2>
          <p>
            Routine optimization is bounded. A full vacuum pauses checks and may need temporary disk
            space.
          </p>
          <div className="stack-actions">
            <button
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => void optimize(false)}
            >
              {busy === 'optimize' ? 'Optimizing…' : 'Optimize database'}
            </button>
            <button
              className="button ghost"
              disabled={Boolean(busy)}
              onClick={() => void optimize(true)}
            >
              {busy === 'vacuum' ? 'Running full vacuum…' : 'Run full vacuum'}
            </button>
            <button
              className="button ghost"
              disabled={Boolean(busy)}
              onClick={() => void removeDeleted()}
            >
              {busy === 'remove-deleted' ? 'Removing…' : 'Remove deleted items with no history'}
            </button>
            <button className="button ghost" onClick={() => void window.opossum.openDataFolder()}>
              <ExternalLink size={15} /> Open data folder
            </button>
            <button className="button ghost" onClick={() => void window.opossum.openLogsFolder()}>
              <ExternalLink size={15} /> Open logs folder
            </button>
          </div>
        </section>
      </div>
      <Modal
        open={Boolean(preview)}
        onOpenChange={(value) => !value && setPreview(undefined)}
        title={preview?.title ?? 'Confirm history purge'}
        description="Review the impact before making this permanent change."
      >
        <div className="impact-preview">
          <strong>{preview?.value.intervalCount ?? 0}</strong>
          <span>status intervals</span>
          <strong>{preview?.value.sessionCount ?? 0}</strong>
          <span>sessions represented</span>
        </div>
        {preview?.options.all && (
          <label className="toggle warning-toggle">
            <input
              type="checkbox"
              checked={Boolean(preview.options.clearLastKnown)}
              onChange={(event) =>
                setPreview({
                  ...preview,
                  options: { ...preview.options, clearLastKnown: event.target.checked },
                })
              }
            />
            <span>Also clear last-known results</span>
          </label>
        )}
        <div className="modal-actions">
          <button className="button ghost" onClick={() => setPreview(undefined)}>
            Cancel
          </button>
          <button
            className="button danger-button"
            disabled={busy === 'purge'}
            onClick={() => void executePurge()}
          >
            {busy === 'purge' ? 'Purging…' : 'Confirm purge'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
