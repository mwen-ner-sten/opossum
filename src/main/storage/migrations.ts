export interface Migration {
  version: number;
  changesStoredData: boolean;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    changesStoredData: false,
    sql: `
      CREATE TABLE schema_version (
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version(version) VALUES (0);

      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_interval_seconds INTEGER NOT NULL,
        default_timeout_seconds INTEGER NOT NULL,
        max_concurrent_checks INTEGER NOT NULL,
        history_max_age_days INTEGER NOT NULL,
        history_max_database_mb INTEGER NOT NULL,
        maintenance_on_startup INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE targets (
        internal_id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        group_name TEXT,
        description TEXT,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE checks (
        internal_id TEXT PRIMARY KEY,
        target_internal_id TEXT NOT NULL REFERENCES targets(internal_id),
        config_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('ping', 'tcp', 'http')),
        enabled INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(target_internal_id, config_id)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_heartbeat_at TEXT NOT NULL,
        application_version TEXT NOT NULL,
        clean_shutdown INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE status_intervals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        target_internal_id TEXT NOT NULL REFERENCES targets(internal_id),
        check_internal_id TEXT NOT NULL REFERENCES checks(internal_id),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_observation_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('UNKNOWN', 'PASS', 'FAIL', 'PAUSED')),
        diagnostic_category TEXT NOT NULL,
        observation_count INTEGER NOT NULL,
        latest_summary TEXT NOT NULL,
        min_duration_ms REAL,
        max_duration_ms REAL,
        total_duration_ms REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE check_last_state (
        check_internal_id TEXT PRIMARY KEY REFERENCES checks(internal_id),
        target_internal_id TEXT NOT NULL REFERENCES targets(internal_id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
        diagnostic_category TEXT NOT NULL,
        summary TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        details_json TEXT
      );

      CREATE TABLE maintenance_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        cutoff_at TEXT,
        intervals_removed INTEGER NOT NULL DEFAULT 0,
        sessions_removed INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE user_preferences (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_checks_target ON checks(target_internal_id);
      CREATE INDEX idx_intervals_check_time ON status_intervals(check_internal_id, started_at, last_observation_at);
      CREATE INDEX idx_intervals_session ON status_intervals(session_id);
      CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
      CREATE INDEX idx_targets_deleted ON targets(deleted_at);
      CREATE INDEX idx_checks_deleted ON checks(deleted_at);
    `,
  },
  {
    version: 2,
    changesStoredData: true,
    sql: `ALTER TABLE maintenance_runs ADD COLUMN details_json TEXT;`,
  },
  {
    // check_last_state.session_id previously had a plain foreign key, which made it impossible to
    // delete any closed session that still held a check's latest result. Rebuild the table so the
    // reference is nullable and clears itself when the session goes away.
    version: 3,
    changesStoredData: true,
    sql: `
      CREATE TABLE check_last_state_v3 (
        check_internal_id TEXT PRIMARY KEY REFERENCES checks(internal_id),
        target_internal_id TEXT NOT NULL REFERENCES targets(internal_id),
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
        diagnostic_category TEXT NOT NULL,
        summary TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        details_json TEXT
      );
      INSERT INTO check_last_state_v3 SELECT
        check_internal_id, target_internal_id, session_id, status, diagnostic_category,
        summary, started_at, completed_at, duration_ms, details_json
      FROM check_last_state;
      DROP TABLE check_last_state;
      ALTER TABLE check_last_state_v3 RENAME TO check_last_state;

      CREATE INDEX idx_intervals_target_time ON status_intervals(target_internal_id, started_at);
      CREATE INDEX idx_maintenance_ended ON maintenance_runs(ended_at DESC);
    `,
  },
  {
    // Reusable check templates. Targets link to a template; the checks it generates are stored
    // in the checks table like any other so history and last-known state keep working.
    version: 4,
    changesStoredData: false,
    sql: `
      CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        checks_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      ALTER TABLE targets ADD COLUMN template_id TEXT;
      ALTER TABLE targets ADD COLUMN vars_json TEXT;
      ALTER TABLE checks ADD COLUMN template_id TEXT;
      CREATE INDEX idx_targets_template ON targets(template_id);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]!.version;
