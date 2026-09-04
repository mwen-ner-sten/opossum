import type Database from 'better-sqlite3';

export type Db = Database.Database;
export type Row = Record<string, unknown>;

export const now = (): string => new Date().toISOString();

export const databaseString = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

export const placeholders = (count: number): string =>
  Array.from({ length: count }, () => '?').join(',');

export interface InternalIds {
  targetInternalId: string;
  checkInternalId?: string;
}
