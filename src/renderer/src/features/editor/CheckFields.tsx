import type { EditableCheck } from './check-helpers';
import { parseHeaders } from './check-helpers';

/**
 * The per-check form shared by the target editor and the template editor. When
 * `placeholders` is set, hints explain that `{{host}}` and friends are substituted per target.
 */
export function CheckFields({
  check,
  idLocked,
  placeholders = false,
  siblings = [],
  onChange,
  onRetype,
}: {
  check: EditableCheck;
  idLocked: boolean;
  placeholders?: boolean;
  /** Other checks on the same target or template that this one may depend on. */
  siblings?: Array<{ id: string; name: string }>;
  onChange(update: Partial<EditableCheck>): void;
  onRetype(type: EditableCheck['type']): void;
}) {
  const dependsOn = check.depends_on ?? [];
  const toggleDependency = (id: string, on: boolean): void => {
    const next = on ? [...dependsOn, id] : dependsOn.filter((item) => item !== id);
    onChange({ depends_on: next.length ? next : undefined });
  };
  const update = (value: Partial<EditableCheck>): void => onChange(value);
  return (
    <div className="form-grid compact">
      <label>
        <span>Check ID</span>
        <input
          value={check.id}
          disabled={idLocked}
          onChange={(event) => update({ id: event.target.value })}
        />
      </label>
      <label>
        <span>Name</span>
        <input value={check.name} onChange={(event) => update({ name: event.target.value })} />
      </label>
      <label>
        <span>Type</span>
        <select
          value={check.type}
          onChange={(event) => onRetype(event.target.value as EditableCheck['type'])}
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
            onChange={(event) => update({ port: Number(event.target.value) })}
          />
        </label>
      )}
      {check.type === 'http' && (
        <>
          <label className="span-2">
            <span>
              URL
              {placeholders && <small> · use {'{{host}}'} for the target address</small>}
            </span>
            <input
              value={check.url}
              placeholder={placeholders ? 'https://{{host}}/' : 'https://host.example/'}
              onChange={(event) => update({ url: event.target.value })}
            />
          </label>
          <label>
            <span>Method</span>
            <select
              value={check.method}
              onChange={(event) => update({ method: event.target.value as 'GET' | 'HEAD' })}
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
                update({
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
              onChange={(event) => update({ contains: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>Forbidden text</span>
            <input
              value={check.not_contains ?? ''}
              onChange={(event) => update({ not_contains: event.target.value || undefined })}
            />
          </label>
          <label>
            <span>Authentication</span>
            <select
              value={check.auth?.type ?? 'none'}
              onChange={(event) =>
                update({
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
                    update({ auth: { ...check.auth!, username_env: event.target.value } })
                  }
                />
              </label>
              <label>
                <span>Password environment variable</span>
                <input
                  value={check.auth.password_env}
                  onChange={(event) =>
                    update({ auth: { ...check.auth!, password_env: event.target.value } })
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
              onChange={(event) => update({ headers: parseHeaders(event.target.value) })}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={check.verify_tls}
              onChange={(event) => update({ verify_tls: event.target.checked })}
            />
            <span>Verify TLS</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={check.follow_redirects}
              onChange={(event) => update({ follow_redirects: event.target.checked })}
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
            update({
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
            update({ timeout_seconds: event.target.value ? Number(event.target.value) : undefined })
          }
        />
      </label>
      <label>
        <span>Failures before FAIL</span>
        <input
          type="number"
          min="1"
          max="10"
          placeholder="1"
          value={check.failures_before_fail ?? ''}
          onChange={(event) =>
            update({
              failures_before_fail: event.target.value ? Number(event.target.value) : undefined,
            })
          }
        />
      </label>
      <label className="span-2">
        <span>Tags (comma separated)</span>
        <input
          value={check.tags.join(', ')}
          onChange={(event) =>
            update({
              tags: event.target.value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      {siblings.length > 0 && (
        <fieldset className="depends-on span-2">
          <legend>
            Runs only after these pass
            <small> · a failing precursor records this check as blocked without running it</small>
          </legend>
          {siblings.map((sibling) => (
            <label key={sibling.id} className="toggle">
              <input
                type="checkbox"
                checked={dependsOn.includes(sibling.id)}
                onChange={(event) => toggleDependency(sibling.id, event.target.checked)}
              />
              <span>
                {sibling.name} <code>{sibling.id}</code>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="toggle span-2">
        <input
          type="checkbox"
          checked={check.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span>Check enabled</span>
      </label>
    </div>
  );
}
