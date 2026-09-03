import { Copy, Download, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import type { TargetConfig } from '@core/config';

export function ConfigurationView({
  targets,
  onAdd,
  onEdit,
  onDuplicate,
  onDelete,
  onToggle,
}: {
  targets: TargetConfig[];
  onAdd(): void;
  onEdit(target: TargetConfig): void;
  onDuplicate(target: TargetConfig): void;
  onDelete(target: TargetConfig): void;
  onToggle(target: TargetConfig): void;
}) {
  return (
    <div className="workspace padded">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Configuration</p>
          <h1>Targets and checks</h1>
          <p>Active configuration is stored locally and changes begin monitoring immediately.</p>
        </div>
        <button className="button primary" onClick={onAdd}>
          <Plus size={16} /> Add target
        </button>
      </div>
      <div className="configuration-list">
        {targets.map((target) => (
          <article className={`config-card ${target.enabled ? '' : 'disabled'}`} key={target.id}>
            <div className="config-summary">
              <div>
                <span className="target-icon">{target.name.slice(0, 2).toUpperCase()}</span>
                <div>
                  <h2>{target.name}</h2>
                  <code>
                    {target.id} · {target.host}
                  </code>
                  <p>{target.description || 'No description'}</p>
                </div>
              </div>
              <span className={`type-pill ${target.enabled ? 'type-http' : 'type-off'}`}>
                {target.enabled ? 'ENABLED' : 'DISABLED'}
              </span>
            </div>
            <div className="config-checks">
              {target.checks.map((check) => (
                <div key={check.id}>
                  <span className={`type-pill type-${check.type}`}>{check.type.toUpperCase()}</span>
                  <strong>{check.name}</strong>
                  <code>{check.id}</code>
                  <small>
                    {check.enabled
                      ? check.interval_seconds
                        ? `Every ${check.interval_seconds} s`
                        : 'Default interval'
                      : 'Disabled'}
                  </small>
                </div>
              ))}
            </div>
            <div className="config-actions">
              <button className="button secondary" onClick={() => onEdit(target)}>
                <Pencil size={15} /> Edit
              </button>
              <button className="button ghost" onClick={() => onDuplicate(target)}>
                <Copy size={15} /> Duplicate
              </button>
              <button
                className="button ghost"
                onClick={() => void window.opossum.exportConfiguration({ targetIds: [target.id] })}
              >
                <Download size={15} /> Export target
              </button>
              <button className="button ghost" onClick={() => onToggle(target)}>
                <Power size={15} /> {target.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="button ghost danger-text" onClick={() => onDelete(target)}>
                <Trash2 size={15} /> Delete
              </button>
            </div>
          </article>
        ))}
        {targets.length === 0 && (
          <div className="empty-state">
            <h2>No configuration yet</h2>
            <p>Create a target or import a YAML configuration to get started.</p>
            <button className="button primary" onClick={onAdd}>
              <Plus size={16} /> Add first target
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
