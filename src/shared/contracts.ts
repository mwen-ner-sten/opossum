import { z } from 'zod';
import type { AppSettings, CheckConfig, TargetConfig } from '@core/config';
import type { LiveCheckState, SessionSummary, TimelineResult } from '@core/models';

export type ImportMode = 'replace' | 'add-only';
export interface ImportConflict {
  kind: 'target' | 'check';
  targetId: string;
  checkId?: string;
  reason: string;
}
export interface ImportPreview {
  filePath: string;
  newTargets: number;
  matchingTargets: number;
  newChecks: number;
  matchingChecks: number;
  conflicts: ImportConflict[];
  configuration: { applicationVersion: string; exportedAt: string };
}
export interface DatabaseStats {
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
  targetCount: number;
  checkCount: number;
  sessionCount: number;
  intervalCount: number;
  oldestHistoryAt?: string;
  newestHistoryAt?: string;
  lastMaintenance?: MaintenanceSummary;
}
export interface MaintenanceSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  reason: string;
  cutoffAt?: string;
  intervalsRemoved: number;
  sessionsRemoved: number;
  error?: string;
}
export interface HistoricalDefinition {
  targetId: string;
  name: string;
  host: string;
  deleted: boolean;
  checks: Array<{ checkId: string; name: string; type: 'ping' | 'tcp' | 'http'; deleted: boolean }>;
}
export type TimelineRange = 'current' | 'previous' | '24h' | '7d' | '30d' | 'all';
export interface PurgeOptions {
  before?: string | undefined;
  sessionIds?: string[] | undefined;
  targetId?: string | undefined;
  checkId?: string | undefined;
  all?: boolean | undefined;
  clearLastKnown?: boolean | undefined;
}
export interface PurgePreview {
  intervalCount: number;
  sessionCount: number;
  oldestAt?: string;
  newestAt?: string;
}
export interface AppSnapshot {
  settings: AppSettings;
  targets: TargetConfig[];
  states: LiveCheckState[];
  session: SessionSummary;
  databaseHealthy: boolean;
  pausedAll: boolean;
  version: string;
  hasExampleConfiguration: boolean;
  adjacentConfigurationPath?: string;
}
export interface SaveCheckInput {
  targetId: string;
  originalCheckId?: string;
  check: CheckConfig;
}
export interface ExportOptions {
  targetIds?: string[];
}
export interface ImportOptions {
  /** A path previously returned by the file dialog or the adjacent-configuration prompt. */
  filePath?: string;
  /** Import the example configuration bundled with the application instead of a file. */
  example?: boolean;
  mode?: ImportMode;
  previewOnly?: boolean;
}
export interface SessionsOptions {
  limit?: number;
  before?: string;
}
export interface TimelineOptions {
  targetId: string;
  checkId?: string;
  range: TimelineRange;
  sessionId?: string;
}
export interface OptimizeOptions {
  fullVacuum?: boolean;
}

export interface OpossumApi {
  getSnapshot(): Promise<AppSnapshot>;
  runCheck(targetId: string, checkId: string): Promise<void>;
  runTarget(targetId: string): Promise<void>;
  runAll(): Promise<void>;
  pauseCheck(targetId: string, checkId: string): Promise<void>;
  resumeCheck(targetId: string, checkId: string): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  listTargets(includeDeleted?: boolean): Promise<TargetConfig[]>;
  saveTarget(target: TargetConfig): Promise<void>;
  saveCheck(input: SaveCheckInput): Promise<void>;
  deleteTarget(targetId: string): Promise<void>;
  deleteCheck(targetId: string, checkId: string): Promise<void>;
  importConfiguration(
    options: ImportOptions,
  ): Promise<ImportPreview | { imported: true } | undefined>;
  exportConfiguration(options: ExportOptions): Promise<string | undefined>;
  getSessions(options?: SessionsOptions): Promise<SessionSummary[]>;
  getTimeline(options: TimelineOptions): Promise<TimelineResult>;
  getDatabaseStats(): Promise<DatabaseStats>;
  previewHistoryPurge(options: PurgeOptions): Promise<PurgePreview>;
  purgeHistory(options: PurgeOptions): Promise<MaintenanceSummary>;
  optimizeDatabase(options: OptimizeOptions): Promise<MaintenanceSummary>;
  listHistoricalDefinitions(): Promise<HistoricalDefinition[]>;
  removeUnusedDeletedItems(): Promise<void>;
  saveSettings(settings: AppSettings): Promise<void>;
  openDataFolder(): Promise<void>;
  openLogsFolder(): Promise<void>;
  onStatusChanged(callback: (states: LiveCheckState[]) => void): () => void;
  onConfigurationChanged(callback: () => void): () => void;
  onMaintenanceChanged(callback: (summary: MaintenanceSummary) => void): () => void;
  onHealthChanged(callback: (healthy: boolean) => void): () => void;
}

export const idArgumentSchema = z.string().min(1).max(80);
export const pairArgumentSchema = z.tuple([idArgumentSchema, idArgumentSchema]);
