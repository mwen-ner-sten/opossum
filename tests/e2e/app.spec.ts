import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

let application: ElectronApplication | undefined;
let dataRoot: string;

test.beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'opossum-e2e-'));
});
test.afterEach(async () => {
  if (application) {
    await application.close().catch(() => undefined);
    application = undefined;
  }
  rmSync(dataRoot, { recursive: true, force: true });
});

async function launch() {
  application = await electron.launch({
    args: ['.'],
    env: { ...process.env, LOCALAPPDATA: dataRoot, NODE_ENV: 'test' },
  });
  const window = await application.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return window;
}

test('first run, local monitoring, clean close, and last-known restoration', async () => {
  let window = await launch();
  await expect(window.getByRole('heading', { name: /Know what is reachable/i })).toBeVisible();
  await window.getByRole('button', { name: 'Add first target' }).click();
  const dialog = window.getByRole('dialog');
  await dialog.getByLabel('Target ID').fill('local-machine');
  await dialog.getByLabel('Display name').fill('Local machine');
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('127.0.0.1');
  // Typing a custom check ID must not lose focus between keystrokes.
  const checkId = dialog.getByLabel('Check ID');
  await checkId.click();
  await checkId.press('Control+a');
  await window.keyboard.type('loopback-ping');
  await expect(checkId).toHaveValue('loopback-ping');
  await dialog.getByRole('button', { name: 'Save target' }).click();
  await expect(window.getByText('Local machine').first()).toBeVisible();
  await expect(window.getByText(/Reply in|No ICMP reply|Timed out/).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.getByText('loopback-ping').first()).toBeVisible();
  await window.getByRole('button', { name: 'Target actions for Local machine' }).click();
  const editDialog = window.getByRole('dialog');
  await editDialog.getByRole('textbox', { name: 'Host', exact: true }).fill('192.0.2.1');
  await editDialog.getByRole('button', { name: 'Save target' }).click();
  const closed = application!.waitForEvent('close');
  await window.close();
  await closed;
  application = undefined;

  window = await launch();
  await expect(window.getByText('Local machine').first()).toBeVisible();
  await expect(window.getByText('Last known').first()).toBeVisible({ timeout: 5_000 });
  // The last-known result must be the genuine reply, never a shutdown cancellation.
  await expect(window.getByText(/canceled/i)).toHaveCount(0);
});

test('example configuration loads and pause all preserves an individual pause', async () => {
  const window = await launch();
  await window.getByRole('button', { name: 'Load example configuration' }).click();
  const dialog = window.getByRole('dialog', { name: 'Load example configuration' });
  await expect(dialog.getByText('new targets')).toBeVisible();
  await dialog.getByRole('button', { name: /Add only new items/ }).click();
  await expect(window.getByText('Chicago BMS Server 01').first()).toBeVisible();

  await window.getByRole('button', { name: 'Pause Host ping' }).first().click();
  // A pause requested mid-run takes effect when the in-flight ping finishes (up to its 5 s
  // timeout). Wait for it before pausing everything so the individual pause is what "Pause all"
  // sees, and "Resume all" leaves it alone.
  await expect(window.getByRole('button', { name: 'Resume Host ping' }).first()).toBeVisible({
    timeout: 15_000,
  });
  await window.getByRole('button', { name: 'Pause all' }).click();
  await expect(window.getByRole('button', { name: 'Resume all' })).toBeVisible();
  await window.getByRole('button', { name: 'Resume all' }).click();
  // The session-wide control flips back to "Pause all" once the resume has been applied.
  await expect(window.getByRole('button', { name: 'Pause all' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Resume Host ping' }).first()).toBeVisible();
  const resumeButtons = await window.getByRole('button', { name: /^Resume / }).count();
  expect(resumeButtons).toBe(1);

  await window
    .getByRole('button', { name: /Show details for Chicago BMS Server 01 Host ping/ })
    .click();
  const details = window.getByRole('complementary', { name: 'Check details' });
  await expect(details.getByText('Fails after')).toBeVisible();
  await expect(details.getByRole('button', { name: 'Copy diagnostic text only' })).toBeVisible();
});

test('keyboard navigation reaches primary workspaces', async () => {
  const window = await launch();
  const monitorButton = window.getByRole('button', { name: 'Monitor', exact: true });
  const historyButton = window.getByRole('button', { name: 'History', exact: true });
  await monitorButton.focus();
  await window.keyboard.press('Tab');
  await expect(historyButton).toBeFocused();
  expect(
    await window.evaluate(() => ({
      require: typeof (globalThis as unknown as Record<string, unknown>).require,
      process: typeof (globalThis as unknown as Record<string, unknown>).process,
    })),
  ).toEqual({ require: 'undefined', process: 'undefined' });
  await expect(
    window.evaluate(() =>
      (
        globalThis as unknown as { opossum: { runCheck(a: string, b: string): Promise<void> } }
      ).opossum.runCheck('', ''),
    ),
  ).rejects.toThrow();
  await expect(
    window.evaluate(() =>
      (
        globalThis as unknown as {
          opossum: { importConfiguration(o: unknown): Promise<unknown> };
        }
      ).opossum.importConfiguration({ filePath: 'C:\\Windows\\win.ini', previewOnly: true }),
    ),
  ).rejects.toThrow(/import dialog/);
  await historyButton.click();
  await expect(window.getByRole('heading', { name: 'Monitoring sessions' })).toBeVisible();
  await window.getByRole('button', { name: /Retention settings/ }).click();
  await expect(
    window.getByRole('heading', { name: 'Defaults, retention, and storage' }),
  ).toBeVisible();
});

test('templates drive linked targets and the import builder creates sites from pasted rows', async () => {
  const window = await launch();
  await window.getByRole('button', { name: 'Load example configuration' }).click();
  await window.getByRole('button', { name: /Replace active configuration/ }).click();
  await expect(window.getByText('Denver BMS Server 01').first()).toBeVisible();

  await window.getByRole('button', { name: 'Targets', exact: true }).click();
  await expect(window.getByText('2 linked targets')).toBeVisible();
  await expect(window.getByText('From template', { exact: false }).first()).toBeVisible();

  await window.getByRole('button', { name: /Paste list/ }).click();
  await window
    .getByLabel('Pasted host list')
    .fill(
      'Site Name,IP Address,Region,Web Port\nPhoenix BMS 01,10.20.40.40,Phoenix,443\nNo host,,Phoenix,443',
    );
  await window.getByRole('button', { name: /Open in import builder/ }).click();
  const builder = window.getByRole('dialog', { name: 'Import builder' });
  await expect(builder.getByLabel('Column for Host / IP (required)')).toHaveValue('IP Address');
  await expect(builder.getByLabel('Default template')).toHaveValue('ebo-site');
  await builder.getByRole('button', { name: /Review targets/ }).click();
  await expect(builder.getByText('Row 2: No host value')).toBeVisible();
  await builder.getByRole('button', { name: /Add 1 new targets/ }).click();
  await expect(window.getByText('Imported 1 target')).toBeVisible();

  await window.getByRole('button', { name: /^Monitor/ }).click();
  await expect(window.getByText('Phoenix BMS 01').first()).toBeVisible();
  await expect(window.getByText('phoenix-bms-01')).toHaveCount(0);
  await window
    .getByRole('button', { name: /Show details for Phoenix BMS 01 EBO WebStation/ })
    .click();
  await expect(
    window
      .getByRole('complementary', { name: 'Check details' })
      .getByText('https://10.20.40.40:443/'),
  ).toBeVisible();
});

// Electron launches its own window; Playwright requires destructuring even without browser fixtures.
// eslint-disable-next-line no-empty-pattern
test('guidance, missing template values, and session sharing work through the app', async ({}, testInfo) => {
  const window = await launch();
  const originalClipboard = await application!.evaluate(({ clipboard }) => clipboard.readText());
  const server = createServer((_req, res) => {
    res.writeHead(503);
    res.end('Unavailable');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP port');
  try {
    await window.evaluate(async (port) => {
      await globalThis.window.opossum.saveTarget({
        id: 'local-service',
        name: 'Local service',
        host: '127.0.0.1',
        enabled: true,
        checks: [
          {
            id: 'web',
            name: 'Web',
            type: 'http',
            url: `http://127.0.0.1:${port}`,
            method: 'GET',
            expected_status: 200,
            headers: {},
            follow_redirects: true,
            verify_tls: true,
            enabled: true,
            tags: [],
          },
        ],
      });
      await globalThis.window.opossum.saveTemplate({
        id: 'missing',
        name: 'Missing values',
        checks: [
          {
            id: 'web',
            name: 'Web',
            type: 'http',
            url: 'https://{{host}}/{{vars.path}}',
            method: 'GET',
            expected_status: 200,
            headers: {},
            follow_redirects: true,
            verify_tls: true,
            enabled: true,
            tags: [],
          },
        ],
      });
      await globalThis.window.opossum.saveTarget({
        id: 'unfinished',
        name: 'Unfinished site',
        host: 'localhost',
        enabled: true,
        template: 'missing',
        checks: [],
      });
    }, address.port);
    await expect(
      window.getByRole('button', { name: 'Configure Unfinished site — needs path' }),
    ).toBeVisible();
    await window.getByRole('button', { name: 'Configure Unfinished site — needs path' }).click();
    await expect(window.getByRole('dialog')).toBeVisible();
    await window.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await window.getByRole('button', { name: 'Show details for Local service Web' }).click();
    const details = window.getByRole('complementary', { name: 'Check details' });
    await expect(details.getByText('Endpoint check failed', { exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Review configuration' })).toBeVisible();
    const filterBounds = await window.getByLabel('Filter by check type').boundingBox();
    const panelBounds = await details.boundingBox();
    expect(filterBounds!.x + filterBounds!.width).toBeLessThanOrEqual(panelBounds!.x);
    await window.getByRole('button', { name: 'Pause all', exact: true }).click();
    await details.getByRole('button', { name: 'Resume monitoring', exact: true }).click();
    await expect(window.getByRole('button', { name: 'Pause all', exact: true })).toBeVisible();
    await expect(details.getByText('Endpoint check failed', { exact: true })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath('check-guidance.png') });
    await window.getByRole('button', { name: 'History', exact: true }).click();
    await window.getByRole('button', { name: 'Copy session summary' }).click();
    await expect(window.getByText('Session summary copied', { exact: true })).toBeVisible();
    const copied = await application!.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain('Local service (127.0.0.1) / Web');
    expect(copied).toContain('HTTP 503');
    const csvPath = join(dataRoot, 'session.csv');
    // Choose a temporary destination through a stub of the native save dialog.
    await application!.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
    }, csvPath);
    await window.getByRole('button', { name: 'Export session CSV' }).click();
    await expect(window.getByText(/Session intervals exported/)).toBeVisible();
    expect(readFileSync(csvPath, 'utf8')).toContain('HTTP 503');
    await window.screenshot({ path: testInfo.outputPath('session-report.png') });
  } finally {
    await application!.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      originalClipboard,
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// eslint-disable-next-line no-empty-pattern
test('500 targets remain searchable while monitoring local HTTP endpoints', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const window = await launch();
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(error.message));
  const server = createServer((_req, res) => {
    res.end('OK');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP port');
  try {
    const start = Date.now();
    await window.evaluate(async (port) => {
      await globalThis.window.opossum.saveTemplate({
        id: 'local-web',
        name: 'Local web',
        checks: [
          {
            id: 'web',
            name: 'Web',
            type: 'http',
            url: `http://{{host}}:${port}`,
            method: 'GET',
            expected_status: 200,
            headers: {},
            follow_redirects: true,
            verify_tls: true,
            enabled: true,
            tags: [],
          },
        ],
      });
      await globalThis.window.opossum.applyTableImport({
        text:
          'Name,Host\n' +
          Array.from(
            { length: 500 },
            (_, i) => `Site ${String(i).padStart(3, '0')},127.0.0.1`,
          ).join('\n'),
        mapping: {
          columns: { name: 'Name', host: 'Host' },
          defaults: { template: 'local-web' },
          vars: {},
        },
        mode: 'add-only',
      });
    }, address.port);
    await expect
      .poll(
        () =>
          window.evaluate(
            async () =>
              (await globalThis.window.opossum.getSnapshot()).states.filter(
                (s) => s.status === 'PASS',
              ).length,
          ),
        { timeout: 30_000 },
      )
      .toBe(500);
    const loadedMs = Date.now() - start;
    const filterStart = Date.now();
    await window.getByRole('textbox', { name: 'Search targets and checks' }).fill('Site 499');
    await expect(window.getByRole('button', { name: /Show details for Site/ })).toHaveCount(1);
    const filteredMs = Date.now() - filterStart;
    expect(filteredMs).toBeLessThan(5000);
    await window.getByRole('button', { name: 'Show details for Site 499 Web' }).click();
    await expect(window.getByRole('complementary', { name: 'Check details' })).toBeVisible();
    expect(errors).toEqual([]);
    const measurement = {
      targets: 500,
      checks: 500,
      loadedAndObservedMs: loadedMs,
      filterMs: filteredMs,
    };
    console.info('Renderer scale:', measurement);
    await testInfo.attach('scale-measurement', {
      body: JSON.stringify(measurement),
      contentType: 'application/json',
    });
    await window.screenshot({ path: testInfo.outputPath('scale-monitor.png') });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
