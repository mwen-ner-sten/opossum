import {
  ClipboardPaste,
  Copy,
  Download,
  Layers,
  Pencil,
  Plus,
  Power,
  Trash2,
  Upload,
} from 'lucide-react';
import type { CheckTemplate, TargetConfig } from '@core/config';

export function ConfigurationView({
  targets,
  templates,
  onAdd,
  onEdit,
  onDuplicate,
  onDelete,
  onToggle,
  onNewTemplate,
  onEditTemplate,
  onDeleteTemplate,
  onImport,
  onPaste,
}: {
  targets: TargetConfig[];
  templates: CheckTemplate[];
  onAdd(): void;
  onEdit(target: TargetConfig): void;
  onDuplicate(target: TargetConfig): void;
  onDelete(target: TargetConfig): void;
  onToggle(target: TargetConfig): void;
  onNewTemplate(): void;
  onEditTemplate(template: CheckTemplate): void;
  onDeleteTemplate(template: CheckTemplate): void;
  onImport(): void;
  onPaste(): void;
}) {
  const linkedCount = (template: CheckTemplate): number =>
    targets.filter((target) => target.template === template.id).length;
  return (
    <div className="workspace padded">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Configuration</p>
          <h1>Targets, templates, and imports</h1>
          <p>Active configuration is stored locally and changes begin monitoring immediately.</p>
        </div>
        <div className="heading-actions">
          <button className="button ghost" onClick={onPaste}>
            <ClipboardPaste size={15} /> Paste list
          </button>
          <button className="button secondary" onClick={onImport}>
            <Upload size={15} /> Import file
          </button>
          <button className="button primary" onClick={onAdd}>
            <Plus size={16} /> Add target
          </button>
        </div>
      </div>

      <section className="template-section">
        <div className="section-heading">
          <div>
            <h2>
              <Layers size={15} /> Templates
            </h2>
            <p>
              Reusable check sets. Link one to any number of targets, or pick it in the import
              builder to create a hundred sites from a spreadsheet.
            </p>
          </div>
          <button className="button secondary" onClick={onNewTemplate}>
            <Plus size={15} /> New template
          </button>
        </div>
        <div className="template-grid">
          {templates.map((template) => {
            const linked = linkedCount(template);
            return (
              <article className="template-card" key={template.id}>
                <div className="template-card-head">
                  <strong>{template.name}</strong>
                  <code>{template.id}</code>
                </div>
                {template.description && <p>{template.description}</p>}
                <div className="template-checks">
                  {template.checks.map((check) => (
                    <span key={check.id}>
                      <span className={`type-pill type-${check.type}`}>
                        {check.type.toUpperCase()}
                      </span>
                      {check.name}
                    </span>
                  ))}
                </div>
                <div className="template-card-foot">
                  <small>
                    {linked} linked target{linked === 1 ? '' : 's'}
                  </small>
                  <span>
                    <button className="mini-button" onClick={() => onEditTemplate(template)}>
                      <Pencil size={13} /> Edit
                    </button>
                    <button
                      className="mini-button danger-text"
                      disabled={linked > 0}
                      title={linked > 0 ? 'Unlink every target before deleting' : 'Delete template'}
                      onClick={() => onDeleteTemplate(template)}
                    >
                      <Trash2 size={13} /> Delete
                    </button>
                  </span>
                </div>
              </article>
            );
          })}
          {templates.length === 0 && (
            <div className="template-empty">
              <p>
                No templates yet. Create one such as “EBO server” with ping, RDP, and a web check
                using <code>{'https://{{host}}/'}</code>, then reuse it everywhere.
              </p>
            </div>
          )}
        </div>
      </section>

      <div className="section-heading" style={{ marginTop: 26 }}>
        <div>
          <h2>Targets</h2>
          <p>
            {targets.length} target{targets.length === 1 ? '' : 's'}
          </p>
        </div>
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
              <div className="config-badges">
                {target.template && (
                  <span className="type-pill template-pill">
                    <Layers size={10} /> {target.template}
                  </span>
                )}
                <span className={`type-pill ${target.enabled ? 'type-http' : 'type-off'}`}>
                  {target.enabled ? 'ENABLED' : 'DISABLED'}
                </span>
              </div>
            </div>
            <div className="config-checks">
              {target.checks.map((check) => (
                <div key={check.id} className={check.from_template ? 'inherited' : ''}>
                  <span className={`type-pill type-${check.type}`}>{check.type.toUpperCase()}</span>
                  <strong>{check.name}</strong>
                  <code>{check.id}</code>
                  <small>
                    {check.from_template ? 'From template · ' : ''}
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
            <h2>No targets yet</h2>
            <p>Create a target, paste a host list, or import a spreadsheet to get started.</p>
            <button className="button primary" onClick={onAdd}>
              <Plus size={16} /> Add first target
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
