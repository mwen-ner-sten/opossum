import { checkTemplateSchema, type CheckTemplate } from '@core/config';
import { OpossumError } from '@shared/errors';
import { now, type Db } from './sql';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  checks_json: string;
  deleted_at: string | null;
}

export class TemplateRepository {
  constructor(
    private readonly db: Db,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  private fromRow(row: TemplateRow): CheckTemplate | undefined {
    const parsed = checkTemplateSchema.safeParse({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      checks: JSON.parse(row.checks_json) as unknown,
    });
    if (parsed.success) return parsed.data;
    this.onWarning(`Skipping template ${row.id}: stored definition is invalid.`);
    return undefined;
  }

  list(): CheckTemplate[] {
    return (
      this.db
        .prepare('SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY lower(name), id')
        .all() as TemplateRow[]
    ).flatMap((row) => this.fromRow(row) ?? []);
  }

  get(id: string): CheckTemplate | undefined {
    const row = this.db
      .prepare('SELECT * FROM templates WHERE id = ? AND deleted_at IS NULL')
      .get(id) as TemplateRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  knownIds(): Set<string> {
    return new Set(
      (this.db.prepare('SELECT id FROM templates').all() as { id: string }[]).map((row) => row.id),
    );
  }

  save(input: CheckTemplate): void {
    const template = checkTemplateSchema.parse(input);
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO templates(id,name,description,checks_json,created_at,updated_at,deleted_at)
         VALUES(?,?,?,?,?,?,NULL)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
           checks_json=excluded.checks_json, updated_at=excluded.updated_at, deleted_at=NULL`,
      )
      .run(
        template.id,
        template.name,
        template.description ?? null,
        JSON.stringify(template.checks),
        timestamp,
        timestamp,
      );
  }

  /** IDs of active targets that inherit from the template. */
  linkedTargetIds(templateId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT config_id FROM targets WHERE template_id = ? AND deleted_at IS NULL ORDER BY config_id',
        )
        .all(templateId) as { config_id: string }[]
    ).map((row) => row.config_id);
  }

  delete(id: string): void {
    const linked = this.linkedTargetIds(id);
    if (linked.length > 0)
      throw new OpossumError(
        'CONFLICT',
        `Template "${id}" is used by ${linked.length} target${linked.length === 1 ? '' : 's'}. Unlink them first.`,
        linked,
      );
    const timestamp = now();
    const result = this.db
      .prepare('UPDATE templates SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
      .run(timestamp, timestamp, id);
    if (result.changes === 0)
      throw new OpossumError('NOT_FOUND', `Template "${id}" was not found.`);
  }
}
