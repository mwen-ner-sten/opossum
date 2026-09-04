import { useEffect, useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { targetSchema, type CheckTemplate, type TargetConfig } from '@core/config';
import {
  ownChecks,
  placeholderUsages,
  resolveChecksPartial,
  templatePlaceholders,
} from '@core/templates';
import { VariableHelp } from './editor/VariableHelp';
import { Modal } from '../components/Modal';
import { CheckEditorList } from './editor/CheckEditorList';
import { newPingCheck } from './editor/check-helpers';

const blankTarget = (): TargetConfig => ({
  id: '',
  name: '',
  host: '',
  enabled: true,
  checks: [newPingCheck()],
});

function parseVars(source: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of source.split('\n')) {
    const split = line.indexOf('=');
    if (split > 0) vars[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return vars;
}
const varsText = (vars: Record<string, string> | undefined): string =>
  Object.entries(vars ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

export function TargetEditor({
  open,
  target,
  duplicate,
  templates,
  onClose,
  onSaved,
}: {
  open: boolean;
  target?: TargetConfig | undefined;
  duplicate?: boolean | undefined;
  templates: CheckTemplate[];
  onClose(): void;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState<TargetConfig>(blankTarget());
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (!target) setDraft(blankTarget());
    else {
      const base = structuredClone(target);
      setDraft({
        ...base,
        checks: ownChecks(base),
        ...(duplicate
          ? {
              id: `${target.id}-copy`,
              name: `${target.name} copy`,
              checks: ownChecks(base).map((check) => ({ ...check, id: `${check.id}-copy` })),
            }
          : {}),
      });
    }
    setErrors([]);
  }, [open, target, duplicate]);

  const template = templates.find((item) => item.id === draft.template);
  const neededVars = useMemo(
    () =>
      template
        ? templatePlaceholders(template)
            .filter((name) => name.startsWith('vars.'))
            .map((name) => name.slice('vars.'.length))
        : [],
    [template],
  );
  const inheritedPreview = useMemo(() => {
    if (!template) return { checks: [], missing: [] as string[], error: '' };
    try {
      const { checks, missing } = resolveChecksPartial(
        {
          ...draft,
          checks: [],
          host: draft.host || 'host.example',
          name: draft.name || 'Target',
          id: draft.id || 'target',
        },
        template,
      );
      return { checks, missing, error: '' };
    } catch (error) {
      return {
        checks: [],
        missing: [] as string[],
        error: error instanceof Error ? error.message : 'Cannot expand',
      };
    }
  }, [template, draft]);
  const ownIds = new Set(draft.checks.map((check) => check.id));

  const save = async (): Promise<void> => {
    const parsed = targetSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
      return;
    }
    if (inheritedPreview.error) {
      setErrors([inheritedPreview.error]);
      return;
    }
    setSaving(true);
    try {
      await window.opossum.saveTarget(parsed.data);
      onSaved();
      onClose();
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Target could not be saved']);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title={
        target && !duplicate
          ? `Edit ${target.name}`
          : duplicate
            ? `Duplicate ${target?.name ?? 'target'}`
            : 'Add target'
      }
      description="Configure the host, optionally link a template, and add any target-specific checks. Changes become active immediately."
      variant="sheet"
      footer={
        <>
          <button className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save target'}
          </button>
        </>
      }
    >
      <div className="editor-block form-grid">
        <label>
          <span>Target ID</span>
          <input
            value={draft.id}
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            placeholder="chi-bms-01"
            disabled={Boolean(target && !duplicate)}
          />
        </label>
        <label>
          <span>Display name</span>
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="Chicago BMS Server"
          />
        </label>
        <label>
          <span>Host</span>
          <input
            value={draft.host}
            onChange={(event) => setDraft({ ...draft, host: event.target.value })}
            placeholder="10.20.30.40 or host.example"
          />
        </label>
        <label>
          <span>Group</span>
          <input
            value={draft.group ?? ''}
            onChange={(event) => setDraft({ ...draft, group: event.target.value || undefined })}
            placeholder="Chicago"
          />
        </label>
        <label className="span-2">
          <span>Description</span>
          <textarea
            value={draft.description ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value || undefined })
            }
            rows={2}
          />
        </label>
        <label className="toggle span-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          <span>Target enabled</span>
        </label>
      </div>

      <div className="editor-block">
        <div className="section-heading">
          <div>
            <h3>
              <Layers size={14} /> Template
            </h3>
            <p>Inherit a reusable set of checks. Edit the template once to update every site.</p>
          </div>
        </div>
        <div className="form-grid">
          <label>
            <span>Linked template</span>
            <select
              aria-label="Linked template"
              value={draft.template ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, template: event.target.value || undefined })
              }
            >
              <option value="">None</option>
              {templates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.checks.length} checks)
                </option>
              ))}
            </select>
          </label>
          {template && (
            <label>
              <span>
                Variables (one key=value per line)
                {neededVars.length > 0 && <small> · needs {neededVars.join(', ')}</small>}
              </span>
              <textarea
                rows={2}
                value={varsText(draft.vars)}
                placeholder={neededVars.map((name) => `${name}=`).join('\n') || 'port=8443'}
                onChange={(event) => {
                  const vars = parseVars(event.target.value);
                  setDraft({ ...draft, vars: Object.keys(vars).length ? vars : undefined });
                }}
              />
            </label>
          )}
        </div>
        {template && (
          <VariableHelp
            usages={placeholderUsages(template)}
            intro="Each variable below is read by the template; give this target its own value for it."
          />
        )}
        {template && (
          <div className="inherited-list" aria-label="Inherited checks">
            {inheritedPreview.missing.length > 0 && (
              <div className="warning-box">
                Set {inheritedPreview.missing.map((name) => `"${name}"`).join(', ')} above to
                activate the inherited checks that read{' '}
                {inheritedPreview.missing.map((name) => `{{vars.${name}}}`).join(', ')}. The target
                can be saved without them.
              </div>
            )}
            {inheritedPreview.error ? (
              <div className="error-box">{inheritedPreview.error}</div>
            ) : (
              inheritedPreview.checks.map((check) => (
                <div
                  key={check.id}
                  className={`inherited-check ${ownIds.has(check.id) ? 'overridden' : ''}`}
                >
                  <span className={`type-pill type-${check.type}`}>{check.type.toUpperCase()}</span>
                  <strong>{check.name}</strong>
                  <code>
                    {check.id}
                    {check.type === 'http' ? ` · ${check.url}` : ''}
                    {check.type === 'tcp' ? ` · port ${check.port}` : ''}
                  </code>
                  <small>{ownIds.has(check.id) ? 'Overridden by own check' : 'Inherited'}</small>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <CheckEditorList
        checks={draft.checks}
        idsLocked={Boolean(target && !duplicate)}
        defaultHost={draft.host || 'example.internal'}
        minimum={draft.template ? 0 : 1}
        inherited={inheritedPreview.checks}
        onChange={(checks) => setDraft({ ...draft, checks })}
      />
      {errors.length > 0 && (
        <div className="error-box" role="alert">
          <strong>Fix these items</strong>
          {errors.map((error) => (
            <div key={error}>{error}</div>
          ))}
        </div>
      )}
    </Modal>
  );
}
