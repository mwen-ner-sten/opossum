import { z } from 'zod';
import { dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { appSettingsSchema, checkSchema, targetSchema } from '@core/config';
import { idArgumentSchema, pairArgumentSchema } from '@shared/contracts';
import { serializeError } from '@shared/errors';
import { IPC } from '@shared/ipc-channels';
import { ApplicationService } from './application';

const importOptionsSchema = z.object({
  filePath: z.string().optional(),
  mode: z.enum(['replace', 'add-only']).optional(),
  previewOnly: z.boolean().optional(),
});
const exportOptionsSchema = z.object({ targetIds: z.array(idArgumentSchema).optional() });
const timelineSchema = z.object({
  targetId: idArgumentSchema,
  checkId: idArgumentSchema.optional(),
  range: z.enum(['current', 'previous', '24h', '7d', '30d', 'all']),
  sessionId: z.string().uuid().optional(),
});
const purgeSchema = z.object({
  before: z.iso.datetime().optional(),
  sessionIds: z.array(z.string()).optional(),
  targetId: idArgumentSchema.optional(),
  checkId: idArgumentSchema.optional(),
  all: z.boolean().optional(),
  clearLastKnown: z.boolean().optional(),
});
let allowedRenderer: (() => WebContents | undefined) | undefined;

function register<T extends z.ZodType>(
  channel: string,
  schema: T,
  handler: (value: z.infer<T>, event: IpcMainInvokeEvent) => unknown,
): void {
  ipcMain.handle(channel, async (event, input: unknown) => {
    try {
      if (!allowedRenderer || event.sender !== allowedRenderer())
        throw new Error('IPC request rejected from an unauthorized sender.');
      return { ok: true, value: await handler(schema.parse(input), event) };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  });
}

export function registerIpc(
  application: ApplicationService,
  dataDirectory: string,
  logsDirectory: string,
  renderer: () => WebContents | undefined,
): void {
  allowedRenderer = renderer;
  register(IPC.snapshot, z.undefined(), () => application.getSnapshot());
  register(IPC.runCheck, pairArgumentSchema, ([targetId, checkId]) =>
    application.scheduler.runCheck(targetId, checkId),
  );
  register(IPC.runTarget, idArgumentSchema, (targetId) =>
    application.scheduler.runTarget(targetId),
  );
  register(IPC.runAll, z.undefined(), () => application.scheduler.runAll());
  register(IPC.pauseCheck, pairArgumentSchema, ([targetId, checkId]) =>
    application.scheduler.pauseCheck(targetId, checkId),
  );
  register(IPC.resumeCheck, pairArgumentSchema, ([targetId, checkId]) =>
    application.scheduler.resumeCheck(targetId, checkId),
  );
  register(IPC.pauseAll, z.undefined(), () => application.scheduler.pauseAllChecks());
  register(IPC.resumeAll, z.undefined(), () => application.scheduler.resumeAllChecks());
  register(IPC.listTargets, z.boolean().optional(), (includeDeleted) =>
    application.repositories.listTargets(includeDeleted),
  );
  register(IPC.saveTarget, targetSchema, (target) => application.saveTarget(target));
  register(
    IPC.saveCheck,
    z.object({
      targetId: idArgumentSchema,
      originalCheckId: idArgumentSchema.optional(),
      check: checkSchema,
    }),
    (input) => {
      application.repositories.saveCheck(input.targetId, input.check, input.originalCheckId);
      application.refreshConfiguration();
    },
  );
  register(IPC.deleteTarget, idArgumentSchema, (id) => application.deleteTarget(id));
  register(IPC.deleteCheck, pairArgumentSchema, ([targetId, checkId]) =>
    application.deleteCheck(targetId, checkId),
  );
  register(IPC.importConfiguration, importOptionsSchema, async (options) => {
    let filePath = options.filePath;
    if (!filePath) {
      const selected = await dialog.showOpenDialog({
        title: 'Import OPOSSUM configuration',
        properties: ['openFile'],
        filters: [{ name: 'YAML configuration', extensions: ['yaml', 'yml'] }],
      });
      filePath = selected.filePaths[0];
    }
    if (!filePath) return undefined;
    return application.importFromFile(filePath, options.previewOnly ? undefined : options.mode);
  });
  register(IPC.exportConfiguration, exportOptionsSchema, async (options) => {
    const selected = await dialog.showSaveDialog({
      title: 'Export OPOSSUM configuration',
      defaultPath: 'opossum.yaml',
      filters: [{ name: 'YAML configuration', extensions: ['yaml'] }],
    });
    if (!selected.filePath) return undefined;
    application.exportToFile(selected.filePath, options.targetIds);
    return selected.filePath;
  });
  register(
    IPC.sessions,
    z
      .object({
        limit: z.number().int().min(1).max(1000).optional(),
        before: z.string().optional(),
      })
      .optional(),
    (options) => application.repositories.listSessions(options?.limit),
  );
  register(IPC.timeline, timelineSchema, (options) =>
    application.getTimeline(options.targetId, options.checkId, options.range, options.sessionId),
  );
  register(IPC.stats, z.undefined(), () => application.getStats());
  register(IPC.previewPurge, purgeSchema, (options) => application.previewPurge(options));
  register(IPC.purge, purgeSchema, (options) => application.purge(options));
  register(IPC.optimize, z.object({ fullVacuum: z.boolean().optional() }), (options) =>
    application.optimize(Boolean(options.fullVacuum)),
  );
  register(IPC.historicalDefinitions, z.undefined(), () =>
    application.repositories.listHistoricalDefinitions(),
  );
  register(IPC.removeDeleted, z.undefined(), () =>
    application.repositories.removeUnusedDeletedItems(),
  );
  register(IPC.saveSettings, appSettingsSchema, (settings) => application.saveSettings(settings));
  register(IPC.openData, z.undefined(), () => shell.openPath(dataDirectory));
  register(IPC.openLogs, z.undefined(), () => shell.openPath(logsDirectory));

  application.setEventHandlers({
    status: (states: unknown) => renderer()?.send(IPC.statusChanged, states),
    configuration: () => renderer()?.send(IPC.configurationChanged),
    maintenance: (summary: unknown) => renderer()?.send(IPC.maintenanceChanged, summary),
  });
}
