import { z } from 'zod';
import { dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { appSettingsSchema, checkSchema, checkTemplateSchema, targetSchema } from '@core/config';
import { SUPPORTED_EXTENSIONS } from './transfer/sources';
import { idArgumentSchema, pairArgumentSchema } from '@shared/contracts';
import { OpossumError, serializeError } from '@shared/errors';
import { IPC } from '@shared/ipc-channels';
import { ApplicationService } from './application';

const importOptionsSchema = z.object({
  filePath: z.string().optional(),
  example: z.boolean().optional(),
  text: z.string().max(5_000_000).optional(),
  mode: z.enum(['replace', 'add-only']).optional(),
  previewOnly: z.boolean().optional(),
});
const columnName = z.string().min(1).max(200);
const importMappingSchema = z.object({
  columns: z
    .object({
      id: columnName.optional(),
      name: columnName.optional(),
      host: columnName.optional(),
      group: columnName.optional(),
      description: columnName.optional(),
      template: columnName.optional(),
      enabled: columnName.optional(),
    })
    .strict(),
  defaults: z
    .object({
      group: z.string().max(100).optional(),
      template: z.string().max(80).optional(),
      idPrefix: z.string().max(40).optional(),
    })
    .strict(),
  vars: z.record(z.string().max(40), columnName),
});
const tableImportSchema = z.object({
  filePath: z.string().optional(),
  text: z.string().max(5_000_000).optional(),
  sheet: z.string().max(200).optional(),
  mapping: importMappingSchema,
  mode: z.enum(['replace', 'add-only']).optional(),
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
  sessionIds: z.array(z.string().uuid()).max(1_000).optional(),
  targetId: idArgumentSchema.optional(),
  checkId: idArgumentSchema.optional(),
  all: z.boolean().optional(),
  clearLastKnown: z.boolean().optional(),
});
const sessionsSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).optional(),
    before: z.iso.datetime().optional(),
  })
  .optional();

let allowedRenderer: (() => WebContents | undefined) | undefined;
/** Only paths the user picked in a dialog (or the adjacent opossum.yaml) may be read for import. */
const approvedImportPaths = new Set<string>();

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
  adjacentConfigurationPath?: string,
): void {
  allowedRenderer = renderer;
  if (adjacentConfigurationPath) approvedImportPaths.add(adjacentConfigurationPath);

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
    const mode = options.previewOnly ? undefined : options.mode;
    if (options.example) return application.importExample(mode);
    if (options.text !== undefined) return application.importFromText(options.text);
    let filePath = options.filePath;
    if (!filePath) {
      const selected = await dialog.showOpenDialog({
        title: 'Import configuration or target list',
        properties: ['openFile'],
        filters: [
          { name: 'All supported files', extensions: SUPPORTED_EXTENSIONS },
          { name: 'OPOSSUM configuration', extensions: ['yaml', 'yml', 'json'] },
          { name: 'Spreadsheets and tables', extensions: ['csv', 'tsv', 'txt', 'xlsx'] },
          { name: 'Structured data', extensions: ['json', 'xml', 'yaml', 'yml'] },
        ],
      });
      filePath = selected.filePaths[0];
      if (filePath) approvedImportPaths.add(filePath);
    }
    if (!filePath) return undefined;
    if (!approvedImportPaths.has(filePath))
      throw new OpossumError(
        'VALIDATION',
        'Choose the configuration file through the import dialog.',
      );
    return application.importFromFile(filePath, mode);
  });
  const assertApprovedPath = (filePath: string | undefined): void => {
    if (filePath && !approvedImportPaths.has(filePath))
      throw new OpossumError('VALIDATION', 'Choose the file through the import dialog.');
  };
  register(IPC.previewTableImport, tableImportSchema, (options) => {
    assertApprovedPath(options.filePath);
    return application.previewTableImport(options);
  });
  register(IPC.applyTableImport, tableImportSchema, (options) => {
    assertApprovedPath(options.filePath);
    return application.applyTableImport(options);
  });
  register(IPC.listTemplates, z.undefined(), () => application.listTemplates());
  register(IPC.saveTemplate, checkTemplateSchema, (template) => application.saveTemplate(template));
  register(IPC.deleteTemplate, idArgumentSchema, (id) => application.deleteTemplate(id));
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
  register(IPC.sessions, sessionsSchema, (options) =>
    application.repositories.listSessions(options?.limit, options?.before),
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
    status: (states) => renderer()?.send(IPC.statusChanged, states),
    configuration: () => renderer()?.send(IPC.configurationChanged),
    maintenance: (summary) => renderer()?.send(IPC.maintenanceChanged, summary),
    health: (healthy) => renderer()?.send(IPC.healthChanged, healthy),
  });
}
