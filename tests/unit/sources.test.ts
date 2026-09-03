import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbook } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDelimitedText, readImportSource } from '../../src/main/transfer/sources';

let directory: string;
const file = (name: string, content: string): string => {
  const path = join(directory, name);
  writeFileSync(path, content, 'utf8');
  return path;
};
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'opossum-sources-'));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('readImportSource', () => {
  it('reads CSV with a BOM and blank lines', async () => {
    const source = await readImportSource(
      file(
        'sites.csv',
        '﻿Site,IP Address,Region\nChicago 01,10.0.0.1,Chicago\n\nDenver,10.0.0.2,West\n',
      ),
    );
    expect(source).toMatchObject({
      kind: 'table',
      format: 'csv',
      columns: ['Site', 'IP Address', 'Region'],
    });
    expect(source.kind === 'table' && source.rows).toEqual([
      { Site: 'Chicago 01', 'IP Address': '10.0.0.1', Region: 'Chicago' },
      { Site: 'Denver', 'IP Address': '10.0.0.2', Region: 'West' },
    ]);
  });
  it('reads TSV and pasted text', () => {
    const source = parseDelimitedText('name\thost\nA\t10.0.0.1\n', 'tsv');
    expect(source.rows).toEqual([{ name: 'A', host: '10.0.0.1' }]);
  });
  it('reads a JSON array and flattens nested objects', async () => {
    const source = await readImportSource(
      file(
        'sites.json',
        JSON.stringify([{ name: 'A', net: { ip: '10.0.0.1' }, tags: ['x', 'y'] }]),
      ),
    );
    expect(source.kind === 'table' && source.rows[0]).toEqual({
      name: 'A',
      'net.ip': '10.0.0.1',
      tags: 'x, y',
    });
  });
  it('finds the record list inside a wrapped YAML document', async () => {
    const source = await readImportSource(
      file(
        'sites.yaml',
        'meta:\n  owner: ops\nsites:\n  - name: A\n    host: 10.0.0.1\n  - name: B\n    host: 10.0.0.2\n',
      ),
    );
    expect(source.kind === 'table' && source.rows.map((row) => row.name)).toEqual(['A', 'B']);
  });
  it('returns a configuration document when the file is an OPOSSUM export', async () => {
    const source = await readImportSource(file('opossum.yaml', 'format_version: 1\ntargets: []\n'));
    expect(source.kind).toBe('configuration');
  });
  it('reads repeated XML elements with attributes', async () => {
    const source = await readImportSource(
      file(
        'sites.xml',
        '<sites><site id="a"><name>A</name><host>10.0.0.1</host></site><site id="b"><name>B</name><host>10.0.0.2</host></site></sites>',
      ),
    );
    expect(source.kind === 'table' && source.rows).toEqual([
      { id: 'a', name: 'A', host: '10.0.0.1' },
      { id: 'b', name: 'B', host: '10.0.0.2' },
    ]);
  });
  it('reads the first worksheet of an XLSX workbook and lists the others', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Sites');
    sheet.addRow(['Name', 'Host', 'Port']);
    sheet.addRow(['A', '10.0.0.1', 443]);
    sheet.addRow([]);
    sheet.addRow(['B', '10.0.0.2', 8443]);
    workbook.addWorksheet('Notes').addRow(['ignored']);
    const path = join(directory, 'sites.xlsx');
    await workbook.xlsx.writeFile(path);
    const source = await readImportSource(path);
    expect(source).toMatchObject({
      kind: 'table',
      format: 'xlsx',
      sheet: 'Sites',
      sheets: ['Sites', 'Notes'],
    });
    expect(source.kind === 'table' && source.rows).toEqual([
      { Name: 'A', Host: '10.0.0.1', Port: '443' },
      { Name: 'B', Host: '10.0.0.2', Port: '8443' },
    ]);
  });
  it('rejects unsupported and unparsable files with a validation error', async () => {
    await expect(readImportSource(file('x.docx', 'nope'))).rejects.toThrow(/Unsupported file type/);
    await expect(readImportSource(file('bad.json', '{'))).rejects.toThrow(/could not be parsed/);
    await expect(readImportSource(file('empty.csv', '\n'))).rejects.toThrow(/column headings/);
  });
});
