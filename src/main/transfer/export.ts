import { stringify } from 'yaml';
import {
  portableConfigurationSchema,
  type AppSettings,
  type PortableConfiguration,
  type TargetConfig,
} from '@core/config';
import { PRODUCT } from '@shared/product';

function orderedTargets(targets: TargetConfig[]): TargetConfig[] {
  return [...targets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((target) => ({
      ...target,
      checks: [...target.checks].sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

export function createPortableConfiguration(
  settings: AppSettings,
  targets: TargetConfig[],
  exportedAt = new Date(),
): PortableConfiguration {
  return portableConfigurationSchema.parse({
    format_version: 1,
    exported_at: exportedAt.toISOString(),
    application_version: PRODUCT.version,
    app: settings,
    targets: orderedTargets(targets),
  });
}

export function exportConfigurationYaml(
  settings: AppSettings,
  targets: TargetConfig[],
  exportedAt = new Date(),
): string {
  return stringify(createPortableConfiguration(settings, targets, exportedAt), {
    lineWidth: 100,
    sortMapEntries: false,
  });
}
