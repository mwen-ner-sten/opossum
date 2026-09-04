import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FlowStep } from '@core/flow';
import { CheckFields } from './CheckFields';
import { CheckFlow } from './CheckFlow';
import {
  newPingCheck,
  normalizeDependencies,
  retypeCheck,
  type EditableCheck,
} from './check-helpers';

const swap = <T,>(items: T[], from: number, to: number): T[] => {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
};

/**
 * Ordered list of check forms. Order matters: checks are steps, and a step may only wait on
 * the steps above it, so the list offers move up/down and a flow chart of the result.
 */
export function CheckEditorList({
  checks,
  idsLocked,
  placeholders = false,
  defaultHost,
  minimum = 1,
  inherited = [],
  onChange,
}: {
  checks: EditableCheck[];
  idsLocked: boolean;
  placeholders?: boolean;
  defaultHost: string;
  /** Fewest checks allowed; the remove button disables at this count. */
  minimum?: number;
  /** Checks inherited from a template; they run first, so own checks may wait on them. */
  inherited?: FlowStep[];
  onChange(checks: EditableCheck[]): void;
}) {
  const [selected, setSelected] = useState<string>();
  const ownIds = new Set(checks.map((check) => check.id));
  const inheritedSteps = inherited.filter((step) => !ownIds.has(step.id));
  const inheritedIds = inheritedSteps.map((step) => step.id);
  const steps: FlowStep[] = [
    ...inheritedSteps,
    ...checks.map((check) => ({
      id: check.id,
      name: check.name,
      type: check.type,
      enabled: check.enabled,
      depends_on: check.depends_on,
    })),
  ];
  const emit = (next: EditableCheck[]): void => onChange(normalizeDependencies(next, inheritedIds));
  const replace = (index: number, check: EditableCheck): void =>
    emit(checks.map((item, position) => (position === index ? check : item)));
  const move = (index: number, direction: -1 | 1): void =>
    emit(swap(checks, index, index + direction));
  const focusCheck = (id: string): void => {
    setSelected(id);
    document.getElementById(`check-editor-${id}`)?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <>
      <div className="section-heading">
        <div>
          <h3>Checks</h3>
          <p>
            {placeholders
              ? 'Each linked target gets a copy of every check with its own address filled in. '
              : 'Each check ID must be unique within this target. '}
            Checks run as steps in this order; a step can wait on any step above it.
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() =>
            emit([
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
      <CheckFlow
        steps={steps}
        startLabel={defaultHost}
        selectedId={selected}
        onSelect={focusCheck}
      />
      <div className="check-editors">
        {checks.map((check, index) => {
          const stepNumber = inheritedSteps.length + index + 1;
          const siblings = [
            ...inheritedSteps.map((step) => ({ id: step.id, name: step.name || step.id })),
            ...checks
              .slice(0, index)
              .filter((item) => item.id)
              .map((item) => ({ id: item.id, name: item.name || item.id })),
          ];
          return (
            <div
              className={`check-editor ${selected === check.id ? 'selected' : ''}`}
              key={index}
              id={`check-editor-${check.id}`}
            >
              <div className="check-editor-head">
                <span className="check-number" title={`Step ${stepNumber}`}>
                  {stepNumber}
                </span>
                <strong>{check.name || 'Untitled check'}</strong>
                <span className={`type-pill type-${check.type}`}>{check.type.toUpperCase()}</span>
                {!check.enabled && <span className="disabled-tag">Disabled</span>}
                <button
                  className="icon-button"
                  aria-label={`Move ${check.name || check.id} up`}
                  title="Move up (earlier step)"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move ${check.name || check.id} down`}
                  title="Move down (later step)"
                  disabled={index === checks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={15} />
                </button>
                <button
                  className="icon-button danger"
                  aria-label={`Remove ${check.name}`}
                  disabled={checks.length <= minimum}
                  title={
                    checks.length <= minimum
                      ? `At least ${minimum} check${minimum === 1 ? ' is' : 's are'} required`
                      : 'Remove this check; its history stays available after saving'
                  }
                  onClick={() => emit(checks.filter((_, item) => item !== index))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <CheckFields
                check={check}
                idLocked={idsLocked}
                placeholders={placeholders}
                siblings={siblings}
                onChange={(update) => replace(index, { ...check, ...update } as EditableCheck)}
                onRetype={(type) => replace(index, retypeCheck(check, type, defaultHost))}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
