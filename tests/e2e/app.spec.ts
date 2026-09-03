import { mkdtempSync, rmSync } from 'node:fs';
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
  await dialog.getByRole('button', { name: 'Save target' }).click();
  await expect(window.getByText('Local machine').first()).toBeVisible();
  await expect(window.getByText(/Reply in|No ICMP reply|Timed out/).first()).toBeVisible({
    timeout: 10_000,
  });
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
  await historyButton.click();
  await expect(window.getByRole('heading', { name: 'Monitoring sessions' })).toBeVisible();
  await window.getByRole('button', { name: 'Data & history', exact: true }).click();
  await expect(window.getByRole('heading', { name: 'Storage and retention' })).toBeVisible();
});
