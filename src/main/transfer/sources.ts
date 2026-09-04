import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import Papa from 'papaparse';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseYaml } from 'yaml';
import type { ImportRow } from '@core/import-mapping';
import { OpossumError } from '@shared/errors';

export type SourceFormat = 'csv' | 'tsv' | 'json' | 'yaml' | 'xml' | 'xlsx' | 'text';

export interface TableSource {
  kind: 'table';
  format: SourceFormat;
  columns: string[];
  rows: ImportRow[];
  /** Workbook sheet names, when the file has more than one. */
  sheets?: string[];
  sheet?: string;
  /** Recognised vendor export, when the rows were normalised from one. */
  flavour?: 'rdm';
  /** Opening portion of the source text, for showing the file as it was received. */
  raw?: string;
}
export interface ConfigurationSource {
  kind: 'configuration';
  /** Raw document already parsed from YAML or JSON; validated by the caller. */
  document: unknown;
}
export type ParsedSource = TableSource | ConfigurationSource;

const MAX_ROWS = 5_000;
const MAX_BYTES = 25 * 1024 * 1024;

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    // ExcelJS cell values: rich text, hyperlinks, and formulas carry the display text inside.
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText))
      return (record.richText as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
    if ('text' in record) return toText(record.text);
    if ('result' in record) return toText(record.result);
    return JSON.stringify(value);
  }
  return '';
}

/** Flattens nested objects into dotted keys so `site.address.ip` can be mapped like a column. */
function flatten(value: unknown, prefix = '', out: ImportRow = {}): ImportRow {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
  } else if (Array.isArray(value)) {
    out[prefix] = value.map(toText).join(', ');
  } else if (prefix) out[prefix] = toText(value);
  return out;
}

function tableFromObjects(format: SourceFormat, items: unknown[]): TableSource {
  const rows = items
    .filter((item) => item && typeof item === 'object')
    .slice(0, MAX_ROWS)
    .map((item) => flatten(item));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0)
    throw new OpossumError('VALIDATION', 'No rows with named fields were found in the file.');
  return { kind: 'table', format, columns, rows };
}

/** Finds the most plausible list of records inside a parsed JSON, YAML, or XML document. */
function findRecords(document: unknown, depth = 0): unknown[] | undefined {
  if (Array.isArray(document)) return document as unknown[];
  if (!document || typeof document !== 'object' || depth > 6) return undefined;
  const entries = Object.entries(document as Record<string, unknown>);
  const preferred = ['targets', 'rows', 'items', 'records', 'sites', 'hosts', 'data', 'devices'];
  for (const key of preferred) {
    const candidate = entries.find(([name]) => name.toLowerCase() === key)?.[1];
    if (Array.isArray(candidate)) return candidate as unknown[];
  }
  let best: unknown[] | undefined;
  for (const [, value] of entries) {
    const found = findRecords(value, depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

/** Devolutions Remote Desktop Manager connection type codes that appear in JSON exports. */
const RDM_CONNECTION_TYPES: Record<number, string> = {
  1: 'RDP',
  2: 'Telnet',
  3: 'Web browser',
  8: 'VNC',
  25: 'Folder',
  36: 'PowerShell',
  44: 'Telnet',
  77: 'SSH shell',
  100: 'Ping',
};
const RDM_HOST_KEYS = ['Terminal.Host', 'Host', 'Url', 'RDP.Host', 'VNC.Host', 'Ssh.Host'];

/**
 * Normalises a Remote Desktop Manager export. Folder entries become the group of their
 * children, the host is lifted out of whichever protocol block holds it, and the numeric
 * connection type is spelled out so it can drive a per-row template choice.
 */
function normaliseRdm(connections: unknown[]): ImportRow[] {
  const flat = connections
    .filter((item) => item && typeof item === 'object')
    .map((item) => flatten(item));
  const byId = new Map(flat.map((row) => [row.ID ?? '', row]));
  const nameOf = (row: ImportRow): string => row.Name ?? '';
  const groupPath = (row: ImportRow, depth = 0): string => {
    const parent = row.ParentID ? byId.get(row.ParentID) : undefined;
    if (!parent || depth > 10) return '';
    const above = groupPath(parent, depth + 1);
    return above ? `${above} / ${nameOf(parent)}` : nameOf(parent);
  };
  const rows: ImportRow[] = [];
  for (const row of flat) {
    const type = Number(row.ConnectionType ?? '');
    const host = RDM_HOST_KEYS.map((key) => row[key] ?? '').find(Boolean) ?? '';
    const isFolder =
      type === 25 || (!host && byId.size > 0 && flat.some((child) => child.ParentID === row.ID));
    if (isFolder) continue;
    rows.push({
      Name: nameOf(row),
      Host: host.replace(/^https?:\/\//i, '').split('/')[0] ?? host,
      Group: groupPath(row) || (row.Group ?? ''),
      'Connection type': RDM_CONNECTION_TYPES[type] ?? row.ConnectionType ?? '',
      Description: row.Description ?? '',
      ...row,
    });
  }
  return rows;
}

function isRdmExport(document: unknown): document is { Connections: unknown[] } {
  if (!document || typeof document !== 'object') return false;
  const connections = (document as { Connections?: unknown }).Connections;
  return (
    Array.isArray(connections) &&
    connections.some(
      (item) => item && typeof item === 'object' && 'ConnectionType' in item && 'Name' in item,
    )
  );
}

function fromDocument(format: SourceFormat, document: unknown): ParsedSource {
  if (document && typeof document === 'object' && 'format_version' in document)
    return { kind: 'configuration', document };
  if (isRdmExport(document)) {
    const rows = normaliseRdm(document.Connections).slice(0, MAX_ROWS);
    if (rows.length === 0)
      throw new OpossumError('VALIDATION', 'The RDM export contains folders only, no hosts.');
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return { kind: 'table', format, columns, rows, flavour: 'rdm' };
  }
  const records = findRecords(document);
  if (!records)
    throw new OpossumError(
      'VALIDATION',
      'The file does not contain a list of records or an OPOSSUM configuration.',
    );
  return tableFromObjects(format, records);
}

export function parseDelimitedText(
  text: string,
  format: 'csv' | 'tsv' | 'text' = 'csv',
): TableSource {
  const result = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    ...(format === 'tsv' ? { delimiter: '\t' } : {}),
  });
  const columns = (result.meta.fields ?? []).filter(Boolean);
  if (columns.length === 0)
    throw new OpossumError('VALIDATION', 'The first line must contain column headings.');
  const rows = result.data
    .slice(0, MAX_ROWS)
    .map((row) => Object.fromEntries(columns.map((column) => [column, toText(row[column])])));
  return { kind: 'table', format, columns, rows };
}

function parseXml(text: string): ParsedSource {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: 'value',
    parseTagValue: false,
    trimValues: true,
    isArray: (_name, jpath) => String(jpath).split('.').length === 2, // root children repeat
  });
  let document: unknown;
  try {
    document = parser.parse(text);
  } catch (error) {
    throw new OpossumError(
      'VALIDATION',
      `XML could not be parsed: ${error instanceof Error ? error.message : 'invalid XML'}`,
    );
  }
  return fromDocument('xml', document);
}

async function parseWorkbook(filePath: string, sheet?: string): Promise<TableSource> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets = workbook.worksheets.map((item) => item.name);
  const worksheet = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
  if (!worksheet)
    throw new OpossumError(
      'VALIDATION',
      `Worksheet "${sheet ?? ''}" was not found in the workbook.`,
    );
  const header = worksheet.getRow(1);
  const columns: Array<{ index: number; name: string }> = [];
  header.eachCell((cellValue, index) => {
    const name = toText(cellValue.value);
    if (name) columns.push({ index, name });
  });
  if (columns.length === 0)
    throw new OpossumError('VALIDATION', 'The first row of the worksheet must contain headings.');
  const rows: ImportRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || rows.length >= MAX_ROWS) return;
    const record: ImportRow = {};
    let hasValue = false;
    for (const column of columns) {
      const value = toText(row.getCell(column.index).value);
      if (value) hasValue = true;
      record[column.name] = value;
    }
    if (hasValue) rows.push(record);
  });
  return {
    kind: 'table',
    format: 'xlsx',
    columns: columns.map((column) => column.name),
    rows,
    ...(sheets.length > 1 ? { sheets } : {}),
    sheet: worksheet.name,
  };
}

export const SUPPORTED_EXTENSIONS = ['yaml', 'yml', 'json', 'csv', 'tsv', 'txt', 'xml', 'xlsx'];
const RAW_PREVIEW_CHARS = 6_000;

/** Attaches the opening portion of the source text to a table so the UI can show the file. */
export function withRaw(source: ParsedSource, text: string): ParsedSource {
  if (source.kind !== 'table') return source;
  return {
    ...source,
    raw: text.length > RAW_PREVIEW_CHARS ? `${text.slice(0, RAW_PREVIEW_CHARS)}\n…` : text,
  };
}

function parseText(extension: string, text: string): ParsedSource {
  switch (extension) {
    case 'yaml':
    case 'yml':
      return fromDocument('yaml', parseYaml(text));
    case 'json':
      return fromDocument('json', JSON.parse(text));
    case 'xml':
      return parseXml(text);
    case 'tsv':
      return parseDelimitedText(text, 'tsv');
    case 'csv':
    case 'txt':
      return parseDelimitedText(text, extension === 'txt' ? 'text' : 'csv');
    default:
      throw new OpossumError(
        'VALIDATION',
        `Unsupported file type ".${extension}". Use ${SUPPORTED_EXTENSIONS.join(', ')}.`,
      );
  }
}

/** Reads any supported file into either a table of rows or a full configuration document. */
export async function readImportSource(filePath: string, sheet?: string): Promise<ParsedSource> {
  const extension = extname(filePath).slice(1).toLowerCase();
  if (extension === 'xlsx') return parseWorkbook(filePath, sheet);
  const buffer = readFileSync(filePath);
  if (buffer.byteLength > MAX_BYTES)
    throw new OpossumError('VALIDATION', 'Import files are limited to 25 MiB.');
  const text = buffer.toString('utf8');
  try {
    return withRaw(parseText(extension, text), text);
  } catch (error) {
    if (error instanceof OpossumError) throw error;
    throw new OpossumError(
      'VALIDATION',
      `File could not be parsed: ${error instanceof Error ? error.message : 'invalid content'}`,
    );
  }
}
