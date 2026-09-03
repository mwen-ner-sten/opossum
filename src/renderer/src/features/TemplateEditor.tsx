import { useEffect, useState } from 'react';
import type { CheckTemplate } from '@core/config';
import { templatePlaceholders, validateTemplate } from '@core/templates';
import { Modal } from '../components/Modal';
import { CheckEditorList } from './editor/CheckEditorList';
import { newPingCheck } from './editor/check-helpers';

const blankTemplate = (): CheckTemplate => ({
  id: '',
  name: '',
  checks: [
    newPingCheck(),
    {
      id: 'web',
      name: 'Web interface',
      type: 'http',
      url: 'https://{{host}}/',
      method: 'GET',
      expected_status: '200-399',
      headers: {},
      verify_tls: true,
      follow_redirects: true,
      enabled: true,
      tags: [],
    },
  ],
});

export function TemplateEditor({
  open,
  template,
  linkedCount = 0,
  onClose,
  onSaved,
}: {
  open: boolean;
  template?: CheckTemplate | undefined;
  /** Targets currently linked; shown so the user knows what a save will regenerate. */
  linkedCount?: number;
  onClose(): void;
  onSaved(message: string): void;
}) {
  const [draft, setDraft] = useState<CheckTemplate>(blankTemplate());
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraft(template ? structuredClone(template) : blankTemplate());
    setErrors([]);
  }, [open, template]);
  const placeholders = templatePlaceholders({ ...draft, checks: draft.checks });

  const save = async (): Promise<void> => {
    const { template: valid, issues } = validateTemplate(draft);
    if (!valid) {
      setErrors(issues.map((issue) => `${issue.path}: ${issue.message}`));
      return;
    }
    setSaving(true);
    try {
      const { relinked } = await window.opossum.saveTemplate(valid);
      onSaved(
        relinked > 0
          ? `Template saved; ${relinked} linked target${relinked === 1 ? '' : 's'} regenerated`
          : 'Template saved',
      );
      onClose();
    } catch (error) {
      const details = (error as Error & { details?: unknown }).details;
      setErrors(
        Array.isArray(details)
          ? details.map((issue: { path?: string; message?: string }) =>
              `${issue.path ?? ''}: ${issue.message ?? 'invalid'}`.trim(),
            )
          : [error instanceof Error ? error.message : 'Template could not be saved'],
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title={template ? `Edit template ${template.name}` : 'New template'}
      description="A template is a reusable set of checks. Link it to any number of targets and each one inherits the checks with its own host substituted."
      variant="sheet"
      footer={
        <>
          {linkedCount > 0 && (
            <span className="footer-note">
              Saving regenerates checks on {linkedCount} linked target{linkedCount === 1 ? '' : 's'}
            </span>
          )}
          <button className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save template'}
          </button>
        </>
      }
    >
      <div className="editor-block form-grid">
        <label>
          <span>Template ID</span>
          <input
            value={draft.id}
            disabled={Boolean(template)}
            placeholder="ebo-server"
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          />
        </label>
        <label>
          <span>Name</span>
          <input
            value={draft.name}
            placeholder="EBO application server"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="span-2">
          <span>Description</span>
          <textarea
            rows={2}
            value={draft.description ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value || undefined })
            }
          />
        </label>
        <div className="placeholder-help span-2">
          <strong>Placeholders</strong>
          <span>
            <code>{'{{host}}'}</code> <code>{'{{name}}'}</code> <code>{'{{id}}'}</code>{' '}
            <code>{'{{group}}'}</code> <code>{'{{vars.key}}'}</code>
          </span>
          {placeholders.length > 0 && (
            <small>
              This template uses: {placeholders.map((item) => `{{${item}}}`).join(', ')}
            </small>
          )}
        </div>
      </div>
      <CheckEditorList
        checks={draft.checks}
        idsLocked={false}
        placeholders
        defaultHost="{{host}}"
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
