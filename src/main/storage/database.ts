import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { OpossumError } from '@shared/errors';
import { LATEST_SCHEMA_VERSION, migrations } from './migrations';

export interface DatabasePaths {
  database: string;
  backups: string;
}

export class DatabaseService {
  readonly db: Database.Database;

  constructor(public readonly paths: DatabasePaths) {
    mkdirSync(dirname(paths.database), { recursive: true });
    mkdirSync(paths.backups, { recursive: true });
    const isNew = !existsSync(paths.database);
    this.db = new Database(paths.database);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    if (isNew) this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma('journal_mode = WAL');
    this.applyMigrations(isNew);
  }

  private currentVersion(): number {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get();
    if (!table) return 0;
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      { version: number } | undefined;
    return row?.version ?? 0;
  }

  private applyMigrations(isNew: boolean): void {
    const version = this.currentVersion();
    if (version > LATEST_SCHEMA_VERSION) {
      this.db.close();
      throw new OpossumError(
        'DATABASE',
        `This database uses schema version ${version}, which is newer than this build supports (${LATEST_SCHEMA_VERSION}). Upgrade OPOSSUM or restore a backup.`,
      );
    }
    const pending = migrations.filter((migration) => migration.version > version);
    if (pending.length === 0) return;
    if (!isNew && pending.some((migration) => migration.changesStoredData)) this.createBackup();
    // Table rebuilds require foreign-key enforcement off; the pragma cannot change inside a
    // transaction, so toggle it around the whole migration run and verify integrity afterwards.
    this.db.pragma('foreign_keys = OFF');
    try {
      for (const migration of pending) {
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db.prepare('UPDATE schema_version SET version = ?').run(migration.version);
        })();
      }
      const violations = this.db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0)
        throw new OpossumError(
          'DATABASE',
          `Migration left ${violations.length} foreign-key violation(s); restore the backup in the backups folder.`,
        );
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  createBackup(): string | undefined {
    if (!existsSync(this.paths.database)) return undefined;
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const destination = join(this.paths.backups, `opossum-${stamp}.db`);
    copyFileSync(this.paths.database, destination);
    const backups = readdirSync(this.paths.backups)
      .filter((name) => /^opossum-.*\.db$/.test(name))
      .sort()
      .reverse();
    for (const old of backups.slice(3)) rmSync(join(this.paths.backups, old));
    return destination;
  }

  close(): void {
    if (this.db.open) {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
    }
  }
}
