import { randomUUID } from 'node:crypto';
import { checkSchema, targetSchema, type CheckConfig, type TargetConfig } from '@core/config';
import type { HistoricalDefinition } from '@shared/contracts';
import { OpossumError } from '@shared/errors';
import { now, placeholders, type Db, type InternalIds } from './sql';

interface TargetRow {
  internal_id: string;
  config_id: string;
  name: string;
  host: string;
  group_name: string | null;
  description: string | null;
  enabled: number;
  deleted_at: string | null;
}
interface CheckRow {
  internal_id: string;
  target_internal_id: string;
  config_id: string;
  config_json: string;
  deleted_at: string | null;
}

export class TargetRepository {
  constructor(
    private readonly db: Db,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  list(includeDeleted = false): TargetConfig[] {
    const targets = this.db
      .prepare(
        `SELECT * FROM targets ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY lower(COALESCE(group_name, '')), lower(name), config_id`,
      )
      .all() as TargetRow[];
    const checkQuery = this.db.prepare(
      `SELECT * FROM checks WHERE target_internal_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY lower(name), config_id`,
    );
    return targets.flatMap((target) => {
      const checks = (checkQuery.all(target.internal_id) as CheckRow[]).flatMap((row) => {
        const parsed = checkSchema.safeParse(JSON.parse(row.config_json));
        if (parsed.success) return [parsed.data];
        // A stored check that no longer validates must not take the whole application down.
        this.onWarning(
          `Skipping check ${target.config_id}/${row.config_id}: stored configuration is invalid.`,
        );
        return [];
      });
      const parsed = targetSchema.safeParse({
        id: target.config_id,
        name: target.name,
        host: target.host,
        ...(target.group_name === null ? {} : { group: target.group_name }),
        ...(target.description === null ? {} : { description: target.description }),
        enabled: Boolean(target.enabled),
        checks,
      });
      if (parsed.success) return [parsed.data];
      this.onWarning(`Skipping target ${target.config_id}: stored configuration is invalid.`);
      return [];
    });
  }

  internalIds(targetId: string, checkId?: string): InternalIds {
    const target = this.db
      .prepare('SELECT internal_id FROM targets WHERE config_id = ?')
      .get(targetId) as { internal_id: string } | undefined;
    if (!target) throw new OpossumError('NOT_FOUND', `Target "${targetId}" was not found.`);
    if (checkId === undefined) return { targetInternalId: target.internal_id };
    const check = this.db
      .prepare('SELECT internal_id FROM checks WHERE target_internal_id = ? AND config_id = ?')
      .get(target.internal_id, checkId) as { internal_id: string } | undefined;
    if (!check)
      throw new OpossumError('NOT_FOUND', `Check "${targetId}/${checkId}" was not found.`);
    return { targetInternalId: target.internal_id, checkInternalId: check.internal_id };
  }

  save(input: TargetConfig, replaceChecks = true): void {
    const target = targetSchema.parse(input);
    this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT internal_id FROM targets WHERE config_id = ?')
        .get(target.id) as { internal_id: string } | undefined;
      const timestamp = now();
      const internalId = existing?.internal_id ?? randomUUID();
      if (existing) {
        this.db
          .prepare(
            `UPDATE targets SET name=?, host=?, group_name=?, description=?, enabled=?, updated_at=?, deleted_at=NULL WHERE internal_id=?`,
          )
          .run(
            target.name,
            target.host,
            target.group ?? null,
            target.description ?? null,
            Number(target.enabled),
            timestamp,
            internalId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO targets(internal_id,config_id,name,host,group_name,description,enabled,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            internalId,
            target.id,
            target.name,
            target.host,
            target.group ?? null,
            target.description ?? null,
            Number(target.enabled),
            timestamp,
            timestamp,
          );
      }
      for (const check of target.checks) this.upsertCheck(internalId, check, undefined);
      if (replaceChecks && target.checks.length > 0) {
        const ids = target.checks.map((check) => check.id);
        this.db
          .prepare(
            `UPDATE checks SET deleted_at=?, updated_at=? WHERE target_internal_id=? AND deleted_at IS NULL AND config_id NOT IN (${placeholders(ids.length)})`,
          )
          .run(timestamp, timestamp, internalId, ...ids);
      }
    })();
  }

  saveCheck(targetId: string, checkInput: CheckConfig, originalCheckId?: string): void {
    const check = checkSchema.parse(checkInput);
    this.db.transaction(() => {
      const { targetInternalId } = this.internalIds(targetId);
      this.upsertCheck(targetInternalId, check, originalCheckId);
    })();
  }

  private upsertCheck(
    targetInternalId: string,
    check: CheckConfig,
    originalCheckId?: string,
  ): void {
    const lookupId = originalCheckId ?? check.id;
    const existing = this.db
      .prepare('SELECT internal_id FROM checks WHERE target_internal_id = ? AND config_id = ?')
      .get(targetInternalId, lookupId) as { internal_id: string } | undefined;
    if (originalCheckId && originalCheckId !== check.id) {
      const conflict = this.db
        .prepare(
          'SELECT internal_id FROM checks WHERE target_internal_id = ? AND config_id = ? AND internal_id != ?',
        )
        .get(targetInternalId, check.id, existing?.internal_id ?? '') as
        { internal_id: string } | undefined;
      if (conflict) throw new OpossumError('CONFLICT', `Check ID "${check.id}" already exists.`);
    }
    const timestamp = now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE checks SET config_id=?, name=?, type=?, enabled=?, config_json=?, updated_at=?, deleted_at=NULL WHERE internal_id=?`,
        )
        .run(
          check.id,
          check.name,
          check.type,
          Number(check.enabled),
          JSON.stringify(check),
          timestamp,
          existing.internal_id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO checks(internal_id,target_internal_id,config_id,name,type,enabled,config_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          targetInternalId,
          check.id,
          check.name,
          check.type,
          Number(check.enabled),
          JSON.stringify(check),
          timestamp,
          timestamp,
        );
    }
  }

  delete(targetId: string): void {
    const { targetInternalId } = this.internalIds(targetId);
    const timestamp = now();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE targets SET deleted_at=?, updated_at=? WHERE internal_id=?')
        .run(timestamp, timestamp, targetInternalId);
      this.db
        .prepare(
          'UPDATE checks SET deleted_at=?, updated_at=? WHERE target_internal_id=? AND deleted_at IS NULL',
        )
        .run(timestamp, timestamp, targetInternalId);
    })();
  }

  deleteCheck(targetId: string, checkId: string): void {
    const { checkInternalId } = this.internalIds(targetId, checkId);
    const timestamp = now();
    this.db
      .prepare('UPDATE checks SET deleted_at=?, updated_at=? WHERE internal_id=?')
      .run(timestamp, timestamp, checkInternalId);
  }

  /** Soft-deletes every active target whose portable ID is not in `keepIds`. */
  softDeleteAbsent(keepIds: string[]): void {
    const timestamp = now();
    if (keepIds.length === 0) {
      this.db
        .prepare('UPDATE targets SET deleted_at=?, updated_at=? WHERE deleted_at IS NULL')
        .run(timestamp, timestamp);
      this.db
        .prepare('UPDATE checks SET deleted_at=?, updated_at=? WHERE deleted_at IS NULL')
        .run(timestamp, timestamp);
      return;
    }
    const absent = this.db
      .prepare(
        `SELECT internal_id FROM targets WHERE deleted_at IS NULL AND config_id NOT IN (${placeholders(keepIds.length)})`,
      )
      .all(...keepIds) as { internal_id: string }[];
    for (const row of absent) {
      this.db
        .prepare('UPDATE targets SET deleted_at=?, updated_at=? WHERE internal_id=?')
        .run(timestamp, timestamp, row.internal_id);
      this.db
        .prepare(
          'UPDATE checks SET deleted_at=?, updated_at=? WHERE target_internal_id=? AND deleted_at IS NULL',
        )
        .run(timestamp, timestamp, row.internal_id);
    }
  }

  knownIds(): Set<string> {
    return new Set(
      (this.db.prepare('SELECT config_id FROM targets').all() as { config_id: string }[]).map(
        (row) => row.config_id,
      ),
    );
  }

  removeUnusedDeleted(): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM checks WHERE deleted_at IS NOT NULL AND internal_id NOT IN (SELECT check_internal_id FROM status_intervals) AND internal_id NOT IN (SELECT check_internal_id FROM check_last_state)`,
        )
        .run();
      this.db
        .prepare(
          `DELETE FROM targets WHERE deleted_at IS NOT NULL AND internal_id NOT IN (SELECT target_internal_id FROM checks) AND internal_id NOT IN (SELECT target_internal_id FROM status_intervals)`,
        )
        .run();
    })();
  }

  listHistoricalDefinitions(): HistoricalDefinition[] {
    const targets = this.db
      .prepare(
        `SELECT internal_id,config_id,name,host,deleted_at FROM targets
      WHERE deleted_at IS NOT NULL OR internal_id IN (SELECT target_internal_id FROM checks WHERE deleted_at IS NOT NULL)
      ORDER BY lower(name)`,
      )
      .all() as Array<{
      internal_id: string;
      config_id: string;
      name: string;
      host: string;
      deleted_at: string | null;
    }>;
    const checks = this.db.prepare(
      'SELECT config_id,name,type,deleted_at FROM checks WHERE target_internal_id=? ORDER BY lower(name)',
    );
    return targets.map((target) => ({
      targetId: target.config_id,
      name: target.name,
      host: target.host,
      deleted: target.deleted_at !== null,
      checks: (
        checks.all(target.internal_id) as Array<{
          config_id: string;
          name: string;
          type: 'ping' | 'tcp' | 'http';
          deleted_at: string | null;
        }>
      ).map((check) => ({
        checkId: check.config_id,
        name: check.name,
        type: check.type,
        deleted: check.deleted_at !== null,
      })),
    }));
  }
}
