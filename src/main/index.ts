import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import log from 'electron-log/main';
import exampleConfigurationYaml from '../../opossum.example.yaml?raw';
import { PRODUCT } from '@shared/product';
import { ApplicationService } from './application';
import { registerIpc } from './ipc';
import { PreferencesStore } from './preferences';
import { DatabaseService } from './storage/database';

const localAppData = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local');
const dataDirectory = join(localAppData, PRODUCT.dataDirectory);
const logsDirectory = join(dataDirectory, 'logs');
mkdirSync(logsDirectory, { recursive: true });
app.setPath('userData', dataDirectory);
app.setName(PRODUCT.name);
app.setAppUserModelId(PRODUCT.appId);
app.enableSandbox();

log.initialize();
log.transports.file.resolvePathFn = () => join(logsDirectory, 'opossum.log');
log.transports.file.maxSize = 1024 * 1024;
log.errorHandler.startCatching({ showDialog: false });

// A second copy would open the same SQLite file and mark this session as abandoned. app.quit()
// is asynchronous, so every startup step below is gated on holding the lock.
const holdsInstanceLock = app.requestSingleInstanceLock();
if (!holdsInstanceLock) {
  log.info('Another OPOSSUM instance is already running; exiting.');
  app.quit();
}

let window: BrowserWindow | undefined;
let application: ApplicationService | undefined;
let shuttingDown = false;

function createWindow(): BrowserWindow {
  const preferences = new PreferencesStore(dataDirectory);
  const bounds = preferences.loadWindow();
  const browserWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#11151b',
    title: PRODUCT.name,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });
  if (bounds.maximized) browserWindow.maximize();
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  browserWindow.once('ready-to-show', () => browserWindow.show());
  browserWindow.on('close', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    try {
      preferences.saveWindow(browserWindow);
    } catch (error) {
      log.warn('Could not save window preferences', error);
    }
    void application?.shutdown().finally(() => {
      browserWindow.destroy();
      app.quit();
    });
  });
  if (process.env.ELECTRON_RENDERER_URL)
    void browserWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void browserWindow.loadFile(join(__dirname, '../renderer/index.html'));
  return browserWindow;
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open data folder', click: () => void shell.openPath(dataDirectory) },
        { label: 'Open logs folder', click: () => void shell.openPath(logsDirectory) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools', visible: !app.isPackaged },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${PRODUCT.name}`,
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: `About ${PRODUCT.name}`,
              message: `${PRODUCT.name} ${PRODUCT.version}`,
              detail: `${PRODUCT.fullName}\n\n${PRODUCT.license}\n${PRODUCT.copyright}`,
            }),
        },
      ],
    },
  ]);
}

app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

void app.whenReady().then(() => {
  if (!holdsInstanceLock) return;
  try {
    const database = new DatabaseService({
      database: join(dataDirectory, 'opossum.db'),
      backups: join(dataDirectory, 'backups'),
    });
    const adjacentConfigurationPath =
      app.isPackaged && existsSync(join(dirname(process.execPath), 'opossum.yaml'))
        ? join(dirname(process.execPath), 'opossum.yaml')
        : undefined;
    application = new ApplicationService(database, {
      logger: log,
      exampleConfigurationYaml,
      ...(adjacentConfigurationPath ? { adjacentConfigurationPath } : {}),
    });
    window = createWindow();
    registerIpc(
      application,
      dataDirectory,
      logsDirectory,
      () => window?.webContents,
      adjacentConfigurationPath,
    );
    Menu.setApplicationMenu(buildMenu());
    application.start();
    if (process.env.OPOSSUM_SMOKE_TEST === '1') {
      setTimeout(() => window?.close(), 1_000);
    }
  } catch (error) {
    log.error('Startup failed', error);
    dialog.showErrorBox(
      'OPOSSUM could not start',
      `The local database could not be opened or migrated. No checks were started.\n\n${error instanceof Error ? error.message : 'Unknown error'}\n\nData folder: ${dataDirectory}`,
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (!shuttingDown) app.quit();
});
