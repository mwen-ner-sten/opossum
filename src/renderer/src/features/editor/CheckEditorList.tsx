import { Plus, Trash2 } from 'lucide-react';
import { CheckFields } from './CheckFields';
import { newPingCheck, retypeCheck, type EditableCheck } from './check-helpers';

/** Numbered, collapsible-looking list of check forms with add and remove controls. */
export function CheckEditorList({
  checks,
  idsLocked,
  placeholders = false,
  defaultHost,
  minimum = 1,
  onChange,
}: {
  checks: EditableCheck[];
  idsLocked: boolean;
  placeholders?: boolean;
  defaultHost: string;
  /** Fewest checks allowed; the remove button disables at this count. */
  minimum?: number;
  onChange(checks: EditableCheck[]): void;
}) {
  const replace = (index: number, check: EditableCheck): void =>
    onChange(checks.map((item, position) => (position === index ? check : item)));
  return (
    <>
      <div className="section-heading">
        <div>
          <h3>Checks</h3>
          <p>
            {placeholders
              ? 'Each linked target gets a copy of every check with its own address filled in.'
              : 'Each check ID must be unique within this target.'}
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() =>
            onChange([
              ...checks,
              {
                ...newPingCheck(),
                id: `check-${checks.length + 1}`,
                name: `Check ${checks.length + 1}`,
              },
            ])
          }
        >
          <Plus size={16} /> Add check
        </button>
      </div>
      <div className="check-editors">
        {checks.map((check, index) => (
          <div className="check-editor" key={index}>
            <div className="check-editor-head">
              <span className="check-number">{index + 1}</span>
              <strong>{check.name || 'Untitled check'}</strong>
              <span className={`type-pill type-${check.type}`}>{check.type.toUpperCase()}</span>
              {!check.enabled && <span className="disabled-tag">Disabled</span>}
              <button
                className="icon-button danger"
                aria-label={`Remove ${check.name}`}
                disabled={checks.length <= minimum}
                title={
                  checks.length <= minimum
                    ? `At least ${minimum} check${minimum === 1 ? ' is' : 's are'} required`
                    : 'Remove this check; its history stays available after saving'
                }
                onClick={() => onChange(checks.filter((_, item) => item !== index))}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <CheckFields
              check={check}
              idLocked={idsLocked}
              placeholders={placeholders}
              onChange={(update) => replace(index, { ...check, ...update } as EditableCheck)}
              onRetype={(type) => replace(index, retypeCheck(check, type, defaultHost))}
            />
          </div>
        ))}
      </div>
    </>
  );
}
