import { DEFAULT_SETTINGS, appSettingsSchema, type AppSettings } from '@core/config';
import { now, type Db, type Row } from './sql';

export class SettingsRepository {
  constructor(private readonly db: Db) {
    this.ensureSettings();
  }

  private ensureSettings(): void {
    const current = this.db.prepare('SELECT id FROM app_settings WHERE id = 1').get();
    if (current) return;
    const settings = DEFAULT_SETTINGS;
    this.db
      .prepare(
        `INSERT INTO app_settings (
        id, default_interval_seconds, default_timeout_seconds, max_concurrent_checks,
        history_max_age_days, history_max_database_mb, maintenance_on_startup, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        settings.default_interval_seconds,
        settings.default_timeout_seconds,
        settings.max_concurrent_checks,
        settings.history_max_age_days,
        settings.history_max_database_mb,
        Number(settings.maintenance_on_startup),
        now(),
      );
  }

  get(): AppSettings {
    const row = this.db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as Row;
    return appSettingsSchema.parse({
      default_interval_seconds: row.default_interval_seconds,
      default_timeout_seconds: row.default_timeout_seconds,
      max_concurrent_checks: row.max_concurrent_checks,
      history_max_age_days: row.history_max_age_days,
      history_max_database_mb: row.history_max_database_mb,
      maintenance_on_startup: Boolean(row.maintenance_on_startup),
    });
  }

  save(settingsInput: AppSettings): void {
    const settings = appSettingsSchema.parse(settingsInput);
    this.db
      .prepare(
        `UPDATE app_settings SET
      default_interval_seconds = ?, default_timeout_seconds = ?, max_concurrent_checks = ?,
      history_max_age_days = ?, history_max_database_mb = ?, maintenance_on_startup = ?, updated_at = ?
      WHERE id = 1`,
      )
      .run(
        settings.default_interval_seconds,
        settings.default_timeout_seconds,
        settings.max_concurrent_checks,
        settings.history_max_age_days,
        settings.history_max_database_mb,
        Number(settings.maintenance_on_startup),
        now(),
      );
  }
}
