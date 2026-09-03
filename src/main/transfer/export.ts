import { stringify } from 'yaml';
import {
  portableConfigurationSchema,
  type AppSettings,
  type CheckTemplate,
  type PortableConfiguration,
  type TargetConfig,
} from '@core/config';
import { ownChecks } from '@core/templates';
import { PRODUCT } from '@shared/product';

function orderedTargets(targets: TargetConfig[]): TargetConfig[] {
  return [...targets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((target) => ({
      ...target,
      // Inherited checks are regenerated from the template on import, so only own checks travel.
      checks: ownChecks(target).sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

/** Only templates that at least one exported target links to are included. */
function referencedTemplates(targets: TargetConfig[], templates: CheckTemplate[]): CheckTemplate[] {
  const used = new Set(targets.map((target) => target.template).filter(Boolean));
  return templates
    .filter((template) => used.has(template.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createPortableConfiguration(
  settings: AppSettings,
  targets: TargetConfig[],
  templates: CheckTemplate[] = [],
  exportedAt = new Date(),
): PortableConfiguration {
  return portableConfigurationSchema.parse({
    format_version: 1,
    exported_at: exportedAt.toISOString(),
    application_version: PRODUCT.version,
    app: settings,
    templates: referencedTemplates(targets, templates),
    targets: orderedTargets(targets),
  });
}

export function exportConfigurationYaml(
  settings: AppSettings,
  targets: TargetConfig[],
  templates: CheckTemplate[] = [],
  exportedAt = new Date(),
): string {
  return stringify(createPortableConfiguration(settings, targets, templates, exportedAt), {
    lineWidth: 100,
    sortMapEntries: false,
  });
}
