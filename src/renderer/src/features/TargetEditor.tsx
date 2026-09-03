import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { targetSchema, type CheckConfig, type TargetConfig } from '@core/config';
import { Modal } from '../components/Modal';

const newCheck = (): CheckConfig => ({
  id: 'host-ping',
  name: 'Host ping',
  type: 'ping',
  enabled: true,
  tags: [],
});
const blankTarget = (): TargetConfig => ({
  id: '',
  name: '',
  host: '',
  enabled: true,
  checks: [newCheck()],
});

function parseHeaders(source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of source.split('\n')) {
    const split = line.indexOf(':');
    if (split > 0) headers[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return headers;
}

export function TargetEditor({
  open,
  target,
  duplicate,
  onClose,
  onSaved,
}: {
  open: boolean;
  target?: TargetConfig | undefined;
  duplicate?: boolean | undefined;
  onClose(): void;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState<TargetConfig>(blankTarget());
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (!target) setDraft(blankTarget());
    else
      setDraft({
        ...structuredClone(target),
        ...(duplicate
          ? {
              id: `${target.id}-copy`,
              name: `${target.name} copy`,
              checks: target.checks.map((check) => ({ ...check, id: `${check.id}-copy` })),
            }
          : {}),
      });
    setErrors([]);
  }, [open, target, duplicate]);

  const updateCheck = (index: number, update: Partial<CheckConfig>): void => {
    setDraft((current) => ({
      ...current,
      checks: current.checks.map((check, item) =>
        item === index ? ({ ...check, ...update } as CheckConfig) : check,
      ),
    }));
  };
  const changeType = (index: number, type: CheckConfig['type']): void => {
    const current = draft.checks[index];
    if (!current) return;
    const common = {
      id: current.id,
      name: current.name,
      enabled: current.enabled,
      tags: current.tags,
      ...(current.interval_seconds ? { interval_seconds: current.interval_seconds } : {}),
      ...(current.timeout_seconds ? { timeout_seconds: current.timeout_seconds } : {}),
    };
    const check: CheckConfig =
      type === 'ping'
        ? { ...common, type }
        : type === 'tcp'
          ? { ...common, type, port: 443 }
          : {
              ...common,
              type,
              url: `https://${draft.host || 'example.internal'}/`,
              method: 'GET',
              expected_status: '200-399',
              headers: {},
              verify_tls: true,
              follow_redirects: true,
            };
    setDraft((value) => ({
      ...value,
      checks: value.checks.map((item, position) => (position === index ? check : item)),
    }));
  };
  const save = async (): Promise<void> => {
    const parsed = targetSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
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
      description="Configure the host and one or more checks. Changes become active immediately."
      wide
    >
      <div className="form-grid">
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
      <div className="section-heading">
        <div>
          <h3>Checks</h3>
          <p>Each check ID must be unique within this target.</p>
        </div>
        <button
          className="button secondary"
          onClick={() =>
            setDraft({
              ...draft,
              checks: [
                ...draft.checks,
                {
                  ...newCheck(),
                  id: `check-${draft.checks.length + 1}`,
                  name: `Check ${draft.checks.length + 1}`,
                },
              ],
            })
          }
        >
          <Plus size={16} /> Add check
        </button>
      </div>
      <div className="check-editors">
        {draft.checks.map((check, index) => (
          <div className="check-editor" key={`${index}-${check.id}`}>
            <div className="check-number">
              <span>{index + 1}</span>
              <button
                className="icon-button danger"
                aria-label={`Remove ${check.name}`}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${check.name}? Its existing history will remain available after you save.`,
                    )
                  )
                    setDraft({
                      ...draft,
                      checks: draft.checks.filter((_, item) => item !== index),
                    });
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="form-grid compact">
              <label>
                <span>Check ID</span>
                <input
                  value={check.id}
                  disabled={Boolean(target && !duplicate)}
                  onChange={(event) => updateCheck(index, { id: event.target.value })}
                />
              </label>
              <label>
                <span>Name</span>
                <input
                  value={check.name}
                  onChange={(event) => updateCheck(index, { name: event.target.value })}
                />
              </label>
              <label>
                <span>Type</span>
                <select
                  value={check.type}
                  onChange={(event) => changeType(index, event.target.value as CheckConfig['type'])}
                >
                  <option value="ping">Ping</option>
                  <option value="tcp">TCP port</option>
                  <option value="http">HTTP / HTTPS</option>
                </select>
              </label>
              {check.type === 'tcp' && (
                <label>
                  <span>Port</span>
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={check.port}
                    onChange={(event) => updateCheck(index, { port: Number(event.target.value) })}
                  />
                </label>
              )}
              {check.type === 'http' && (
                <>
                  <label className="span-2">
                    <span>URL</span>
                    <input
                      value={check.url}
                      onChange={(event) => updateCheck(index, { url: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Method</span>
                    <select
                      value={check.method}
                      onChange={(event) =>
                        updateCheck(index, { method: event.target.value as 'GET' | 'HEAD' })
                      }
                    >
                      <option>GET</option>
                      <option>HEAD</option>
                    </select>
                  </label>
                  <label>
                    <span>Expected status</span>
                    <input
                      value={
                        Array.isArray(check.expected_status)
                          ? check.expected_status.join(',')
                          : check.expected_status
                      }
                      onChange={(event) =>
                        updateCheck(index, {
                          expected_status: /^\d+$/.test(event.target.value)
                            ? Number(event.target.value)
                            : event.target.value.includes(',')
                              ? event.target.value.split(',').map(Number)
                              : event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Required text</span>
                    <input
                      value={check.contains ?? ''}
                      onChange={(event) =>
                        updateCheck(index, { contains: event.target.value || undefined })
                      }
                    />
                  </label>
                  <label>
                    <span>Forbidden text</span>
                    <input
                      value={check.not_contains ?? ''}
                      onChange={(event) =>
                        updateCheck(index, { not_contains: event.target.value || undefined })
                      }
                    />
                  </label>
                  <label>
                    <span>Authentication</span>
                    <select
                      value={check.auth?.type ?? 'none'}
                      onChange={(event) =>
                        updateCheck(index, {
                          auth:
                            event.target.value === 'none'
                              ? undefined
                              : {
                                  type: event.target.value as 'basic' | 'digest',
                                  username_env: check.auth?.username_env ?? 'OPOSSUM_USERNAME',
                                  password_env: check.auth?.password_env ?? 'OPOSSUM_PASSWORD',
                                },
                        })
                      }
                    >
                      <option value="none">None</option>
                      <option value="basic">Basic</option>
                      <option value="digest">Digest</option>
                    </select>
                  </label>
                  {check.auth && (
                    <>
                      <label>
                        <span>Username environment variable</span>
                        <input
                          value={check.auth.username_env}
                          onChange={(event) =>
                            updateCheck(index, {
                              auth: { ...check.auth!, username_env: event.target.value },
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Password environment variable</span>
                        <input
                          value={check.auth.password_env}
                          onChange={(event) =>
                            updateCheck(index, {
                              auth: { ...check.auth!, password_env: event.target.value },
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  <label className="span-2">
                    <span>Static headers (one Name: Value per line)</span>
                    <textarea
                      rows={2}
                      value={Object.entries(check.headers)
                        .map(([name, value]) => `${name}: ${value}`)
                        .join('\n')}
                      onChange={(event) =>
                        updateCheck(index, {
                          headers: parseHeaders(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={check.verify_tls}
                      onChange={(event) => updateCheck(index, { verify_tls: event.target.checked })}
                    />
                    <span>Verify TLS</span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={check.follow_redirects}
                      onChange={(event) =>
                        updateCheck(index, { follow_redirects: event.target.checked })
                      }
                    />
                    <span>Follow redirects</span>
                  </label>
                </>
              )}
              <label>
                <span>Interval seconds</span>
                <input
                  type="number"
                  placeholder="App default"
                  value={check.interval_seconds ?? ''}
                  onChange={(event) =>
                    updateCheck(index, {
                      interval_seconds: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </label>
              <label>
                <span>Timeout seconds</span>
                <input
                  type="number"
                  placeholder="App default"
                  value={check.timeout_seconds ?? ''}
                  onChange={(event) =>
                    updateCheck(index, {
                      timeout_seconds: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </label>
              <label className="span-2">
                <span>Tags (comma separated)</span>
                <input
                  value={check.tags.join(', ')}
                  onChange={(event) =>
                    updateCheck(index, {
                      tags: event.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label className="toggle span-2">
                <input
                  type="checkbox"
                  checked={check.enabled}
                  onChange={(event) => updateCheck(index, { enabled: event.target.checked })}
                />
                <span>Check enabled</span>
              </label>
            </div>
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <div className="error-box" role="alert">
          <strong>Fix these items</strong>
          {errors.map((error) => (
            <div key={error}>{error}</div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="button ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save target'}
        </button>
      </div>
    </Modal>
  );
}
