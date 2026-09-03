import { ipcRenderer } from 'electron';
import type { OpossumApi } from '@shared/contracts';
import type { SerializedError } from '@shared/errors';
import { IPC } from '@shared/ipc-channels';

interface Response<T> {
  ok: boolean;
  value?: T;
  error?: SerializedError;
}

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const response = (await ipcRenderer.invoke(channel, input)) as Response<T>;
  if (!response.ok) {
    const error = new Error(response.error?.message ?? 'Operation failed');
    Object.assign(error, response.error);
    throw error;
  }
  return response.value as T;
}

function event<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export const api: OpossumApi = {
  getSnapshot: () => invoke(IPC.snapshot),
  runCheck: (targetId, checkId) => invoke(IPC.runCheck, [targetId, checkId]),
  runTarget: (targetId) => invoke(IPC.runTarget, targetId),
  runAll: () => invoke(IPC.runAll),
  pauseCheck: (targetId, checkId) => invoke(IPC.pauseCheck, [targetId, checkId]),
  resumeCheck: (targetId, checkId) => invoke(IPC.resumeCheck, [targetId, checkId]),
  pauseAll: () => invoke(IPC.pauseAll),
  resumeAll: () => invoke(IPC.resumeAll),
  listTargets: (includeDeleted) => invoke(IPC.listTargets, includeDeleted),
  saveTarget: (target) => invoke(IPC.saveTarget, target),
  saveCheck: (input) => invoke(IPC.saveCheck, input),
  deleteTarget: (targetId) => invoke(IPC.deleteTarget, targetId),
  deleteCheck: (targetId, checkId) => invoke(IPC.deleteCheck, [targetId, checkId]),
  importConfiguration: (options) => invoke(IPC.importConfiguration, options),
  exportConfiguration: (options) => invoke(IPC.exportConfiguration, options),
  getSessions: (options) => invoke(IPC.sessions, options),
  getTimeline: (options) => invoke(IPC.timeline, options),
  getDatabaseStats: () => invoke(IPC.stats),
  previewHistoryPurge: (options) => invoke(IPC.previewPurge, options),
  purgeHistory: (options) => invoke(IPC.purge, options),
  optimizeDatabase: (options) => invoke(IPC.optimize, options),
  listHistoricalDefinitions: () => invoke(IPC.historicalDefinitions),
  removeUnusedDeletedItems: () => invoke(IPC.removeDeleted),
  saveSettings: (settings) => invoke(IPC.saveSettings, settings),
  openDataFolder: () => invoke(IPC.openData),
  openLogsFolder: () => invoke(IPC.openLogs),
  onStatusChanged: (callback) => event(IPC.statusChanged, callback),
  onConfigurationChanged: (callback) => event(IPC.configurationChanged, callback),
  onMaintenanceChanged: (callback) => event(IPC.maintenanceChanged, callback),
  onHealthChanged: (callback) => event(IPC.healthChanged, callback),
};
