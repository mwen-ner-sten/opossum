import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileText, Table2, Wand2 } from 'lucide-react';
import type { CheckTemplate } from '@core/config';
import {
  MAPPED_FIELDS,
  buildTargetsFromRows,
  templateVariables,
  type ImportMapping,
  type MappedField,
} from '@core/import-mapping';
import type { ImportMode, TableImportPreview, TableImportSource } from '@shared/contracts';
import { CapacityNote } from '../components/CapacityNote';
import { Modal } from '../components/Modal';

const FIELD_LABELS: Record<MappedField, string> = {
  host: 'Host / IP (required)',
  name: 'Display name',
  id: 'Target ID',
  group: 'Group',
  description: 'Description',
  template: 'Template ID',
  enabled: 'Enabled flag',
};

function describe(error: unknown): string {
  const details = (error as Error & { details?: unknown }).details;
  if (Array.isArray(details) && details.length)
    return `${(error as Error).message}\n${details
      .slice(0, 6)
      .map((issue: { row?: number; message?: string }) =>
        issue.row ? `Row ${issue.row}: ${issue.message ?? ''}` : (issue.message ?? ''),
      )
      .join('\n')}`;
  return error instanceof Error ? error.message : 'The import could not be completed.';
}

/**
 * Two-step sheet: map the columns of a tabular file (or pasted text) to target fields and a
 * template, then review the generated targets before applying them.
 */
export function ImportBuilder({
  source,
  text,
  templates,
  onClose,
  onImported,
  onError,
}: {
  source: TableImportSource | undefined;
  /** Pasted text the source was parsed from, when there is no file. */
  text?: string | undefined;
  templates: CheckTemplate[];
  onClose(): void;
  onImported(message: string): void;
  onError(message: string): void;
}) {
  const [mapping, setMapping] = useState<ImportMapping>({ columns: {}, defaults: {}, vars: {} });
  const [step, setStep] = useState<'map' | 'review'>('map');
  const [preview, setPreview] = useState<TableImportPreview>();
  const [busy, setBusy] = useState('');
  const [pane, setPane] = useState<'mapped' | 'rows' | 'raw'>('mapped');
  // Live projection of the sample rows through the current mapping, so every change is visible.
  const mapped = useMemo(
    () => (source ? buildTargetsFromRows(source.sample, mapping, templates) : undefined),
    [source, mapping, templates],
  );
  useEffect(() => {
    if (!source) return;
    setMapping({
      ...source.suggestedMapping,
      defaults: {
        ...source.suggestedMapping.defaults,
        ...(!source.suggestedMapping.columns.template && templates.length === 1
          ? { template: templates[0]!.id }
          : {}),
      },
    });
    setStep('map');
    setPreview(undefined);
  }, [source, templates]);
  if (!source) return null;

  const request = { filePath: source.filePath || undefined, text, sheet: source.sheet, mapping };
  const setColumn = (field: MappedField, column: string): void =>
    setMapping({ ...mapping, columns: { ...mapping.columns, [field]: column || undefined } });
  const setVar = (key: string, column: string): void => {
    const vars = { ...mapping.vars };
    if (column) vars[key] = column;
    else delete vars[key];
    setMapping({ ...mapping, vars });
  };
  const addVar = (column: string): void => {
    const key = column
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (key && !mapping.vars[key]) setVar(key, column);
  };
  const review = async (): Promise<void> => {
    setBusy('preview');
    try {
      setPreview(await window.opossum.previewTableImport(request));
      setStep('review');
    } catch (error) {
      onError(describe(error));
    } finally {
      setBusy('');
    }
  };
  const apply = async (mode: ImportMode): Promise<void> => {
    setBusy('apply');
    try {
      const { imported } = await window.opossum.applyTableImport({ ...request, mode });
      onImported(`Imported ${imported} target${imported === 1 ? '' : 's'}`);
      onClose();
    } catch (error) {
      onError(describe(error));
    } finally {
      setBusy('');
    }
  };
  const mappedColumns = new Set([
    ...Object.values(mapping.columns).filter(Boolean),
    ...Object.values(mapping.vars),
  ]);
  const unmapped = source.columns.filter((column) => !mappedColumns.has(column));
  const defaultTemplate = templates.find((item) => item.id === mapping.defaults.template);
  const neededVars = templateVariables(defaultTemplate);
  const missingVars = neededVars.filter((name) => !mapping.vars[name]);
  const canReview =
    Boolean(mapping.columns.host) &&
    (Boolean(mapping.columns.template) || Boolean(mapping.defaults.template));

  return (
    <Modal
      open={Boolean(source)}
      onOpenChange={(value) => !value && onClose()}
      title="Import builder"
      description={`${source.rowCount} rows from ${source.filePath ? source.filePath.split(/[\\/]/).pop() : 'pasted text'} (${source.format.toUpperCase()}${source.sheet ? ` · sheet ${source.sheet}` : ''}). Map columns to target fields, pick a template, then review.`}
      variant="sheet"
      wide={step === 'map'}
      footer={
        step === 'map' ? (
          <>
            <button className="button ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!canReview || busy === 'preview'}
              onClick={() => void review()}
            >
              {busy === 'preview' ? 'Building…' : 'Review targets'} <ArrowRight size={15} />
            </button>
          </>
        ) : (
          <>
            <button className="button ghost" onClick={() => setStep('map')}>
              Back to mapping
            </button>
            <button
              className="button secondary"
              disabled={busy === 'apply' || !preview?.targets.length}
              onClick={() => void apply('replace')}
              title="Update matching IDs, add new ones, and soft-delete active targets not in this file"
            >
              Replace active targets
            </button>
            <button
              className="button primary"
              disabled={busy === 'apply' || !preview?.targets.length}
              onClick={() => void apply('add-only')}
            >
              {busy === 'apply'
                ? 'Importing…'
                : `Add ${preview?.preview.newTargets ?? 0} new targets`}
            </button>
          </>
        )
      }
    >
      {step === 'map' ? (
        <div className="builder-layout">
          <div className="builder-controls">
            <div className="editor-block">
              <div className="section-heading">
                <div>
                  <h3>Target fields</h3>
                  <p>
                    Only the host is required. Blank name and ID are derived from other columns.
                  </p>
                </div>
              </div>
              <div className="form-grid">
                {MAPPED_FIELDS.map((field) => (
                  <label key={field}>
                    <span>{FIELD_LABELS[field]}</span>
                    <select
                      aria-label={`Column for ${FIELD_LABELS[field]}`}
                      value={mapping.columns[field] ?? ''}
                      onChange={(event) => setColumn(field, event.target.value)}
                    >
                      <option value="">
                        {field === 'host' ? 'Choose a column…' : 'Not mapped'}
                      </option>
                      {source.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <div className="editor-block">
              <div className="section-heading">
                <div>
                  <h3>Defaults</h3>
                  <p>Used when a row has no value in the mapped column.</p>
                </div>
              </div>
              <div className="form-grid three">
                <label>
                  <span>Template for every row</span>
                  <select
                    aria-label="Default template"
                    value={mapping.defaults.template ?? ''}
                    onChange={(event) =>
                      setMapping({
                        ...mapping,
                        defaults: {
                          ...mapping.defaults,
                          template: event.target.value || undefined,
                        },
                      })
                    }
                  >
                    <option value="">
                      {mapping.columns.template ? 'From column only' : 'Choose a template…'}
                    </option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name} ({template.checks.length} checks)
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Group</span>
                  <input
                    value={mapping.defaults.group ?? ''}
                    placeholder="Optional"
                    onChange={(event) =>
                      setMapping({
                        ...mapping,
                        defaults: { ...mapping.defaults, group: event.target.value || undefined },
                      })
                    }
                  />
                </label>
                <label>
                  <span>ID prefix</span>
                  <input
                    value={mapping.defaults.idPrefix ?? ''}
                    placeholder="site-"
                    onChange={(event) =>
                      setMapping({
                        ...mapping,
                        defaults: {
                          ...mapping.defaults,
                          idPrefix: event.target.value || undefined,
                        },
                      })
                    }
                  />
                </label>
              </div>
              {templates.length === 0 && (
                <div className="warning-box">
                  No templates exist yet. Create one under Configuration so imported rows have
                  checks.
                </div>
              )}
              {neededVars.length > 0 && (
                <div className={missingVars.length ? 'warning-box' : 'info-box'}>
                  Template <strong>{defaultTemplate?.name}</strong> reads{' '}
                  {neededVars.map((name) => (
                    <code key={name} className={missingVars.includes(name) ? 'missing' : ''}>
                      {`{{vars.${name}}}`}
                    </code>
                  ))}
                  {missingVars.length > 0 && (
                    <>
                      {' '}
                      — map a column to {missingVars.map((name) => `"${name}"`).join(', ')} under
                      Template variables, or every row will be skipped.
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="editor-block">
              <div className="section-heading">
                <div>
                  <h3>Template variables</h3>
                  <p>
                    Columns exposed to templates as <code>{'{{vars.name}}'}</code>.
                  </p>
                </div>
              </div>
              {Object.keys(mapping.vars).length > 0 && (
                <div className="var-rows">
                  {Object.entries(mapping.vars).map(([key, column]) => (
                    <div key={key} className="var-row">
                      <code>{`{{vars.${key}}}`}</code>
                      <span>←</span>
                      <select
                        aria-label={`Column for variable ${key}`}
                        value={column}
                        onChange={(event) => setVar(key, event.target.value)}
                      >
                        <option value="">Remove</option>
                        {source.columns.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
              {unmapped.length > 0 && (
                <div className="unmapped">
                  <span>Unmapped columns:</span>
                  {unmapped.map((column) => (
                    <button key={column} className="mini-button" onClick={() => addVar(column)}>
                      + {column}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <aside className="builder-preview" aria-label="Import preview">
            <div className="preview-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={pane === 'mapped'}
                className={pane === 'mapped' ? 'active' : ''}
                onClick={() => setPane('mapped')}
              >
                <Wand2 size={13} /> Mapped targets
              </button>
              <button
                role="tab"
                aria-selected={pane === 'rows'}
                className={pane === 'rows' ? 'active' : ''}
                onClick={() => setPane('rows')}
              >
                <Table2 size={13} /> Source rows
              </button>
              {source.rawPreview && (
                <button
                  role="tab"
                  aria-selected={pane === 'raw'}
                  className={pane === 'raw' ? 'active' : ''}
                  onClick={() => setPane('raw')}
                >
                  <FileText size={13} /> Raw file
                </button>
              )}
            </div>
            <p className="preview-caption">
              {pane === 'mapped'
                ? `How the first ${source.sample.length} of ${source.rowCount} rows become targets with the current mapping.`
                : pane === 'rows'
                  ? `First ${source.sample.length} of ${source.rowCount} rows as parsed. Mapped columns are highlighted.`
                  : 'Opening of the file as received.'}
            </p>
            {pane === 'mapped' && mapped && (
              <div className="scroll-x preview-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>ID</th>
                      <th>Name</th>
                      <th>Host</th>
                      <th>Group</th>
                      <th>Template</th>
                      <th>Variables</th>
                    </tr>
                  </thead>
                  <tbody>
                    {source.sample.map((_, index) => {
                      const issue = mapped.issues.find((item) => item.row === index + 1);
                      const skipped = mapped.issues.filter((item) => item.row <= index).length;
                      const target = issue ? undefined : mapped.targets[index - skipped];
                      return (
                        <tr key={index} className={issue ? 'row-issue' : ''}>
                          <td className="mono">{index + 1}</td>
                          {issue ? (
                            <td colSpan={6} className="issue-cell">
                              Skipped: {issue.message}
                            </td>
                          ) : (
                            <>
                              <td>
                                <code>{target?.id}</code>
                              </td>
                              <td>{target?.name}</td>
                              <td>
                                <code>{target?.host}</code>
                              </td>
                              <td>{target?.group ?? ''}</td>
                              <td>{target?.template ?? ''}</td>
                              <td>
                                <code>
                                  {Object.entries(target?.vars ?? {})
                                    .map(([key, value]) => `${key}=${value}`)
                                    .join(' ')}
                                </code>
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {pane === 'rows' && (
              <div className="scroll-x preview-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {source.columns.map((column) => (
                        <th key={column} className={mappedColumns.has(column) ? 'mapped' : ''}>
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {source.sample.map((row, index) => (
                      <tr key={index}>
                        {source.columns.map((column) => (
                          <td key={column} className={mappedColumns.has(column) ? 'mapped' : ''}>
                            {row[column]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {pane === 'raw' && source.rawPreview && (
              <pre className="raw-preview preview-scroll">{source.rawPreview}</pre>
            )}
          </aside>
        </div>
      ) : (
        preview && (
          <>
            <div className="import-grid">
              <div>
                <strong>{preview.preview.newTargets}</strong>
                <span>new targets</span>
              </div>
              <div>
                <strong>{preview.preview.matchingTargets}</strong>
                <span>matching targets</span>
              </div>
              <div>
                <strong>{preview.targets.length}</strong>
                <span>rows ready</span>
              </div>
              <div>
                <strong className={preview.issues.length ? 'fail-text' : ''}>
                  {preview.issues.length}
                </strong>
                <span>rows skipped</span>
              </div>
            </div>
            {preview.issues.length > 0 && (
              <div className="warning-box">
                {preview.issues.slice(0, 12).map((issue) => (
                  <div key={`${issue.row}-${issue.message}`}>
                    Row {issue.row}: {issue.message}
                  </div>
                ))}
                {preview.issues.length > 12 && <div>…and {preview.issues.length - 12} more</div>}
              </div>
            )}
            <CapacityNote
              assessment={preview.projectedCapacity}
              heading="After this import"
              compact
            />
            {preview.preview.conflicts.length > 0 && (
              <div className="warning-box">
                {preview.preview.conflicts.map((conflict) => (
                  <div key={`${conflict.targetId}-${conflict.reason}`}>
                    {conflict.targetId}: {conflict.reason}
                  </div>
                ))}
              </div>
            )}
            <div className="editor-block scroll-x" style={{ marginTop: 14 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Host</th>
                    <th>Group</th>
                    <th>Template</th>
                    <th>Variables</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.targets.slice(0, 200).map((target) => (
                    <tr key={target.id}>
                      <td>
                        <code>{target.id}</code>
                      </td>
                      <td>{target.name}</td>
                      <td>
                        <code>{target.host}</code>
                      </td>
                      <td>{target.group ?? ''}</td>
                      <td>{target.template ?? ''}</td>
                      <td>
                        <code>
                          {Object.entries(target.vars ?? {})
                            .map(([key, value]) => `${key}=${value}`)
                            .join(' ')}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.targets.length > 200 && (
                <p className="table-note">Showing the first 200 of {preview.targets.length}.</p>
              )}
            </div>
          </>
        )
      )}
    </Modal>
  );
}
