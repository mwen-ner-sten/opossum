import { parse } from 'yaml';
import {
  portableConfigurationSchema,
  type PortableConfiguration,
  type TargetConfig,
} from '@core/config';
import type { ImportConflict, ImportPreview } from '@shared/contracts';
import { OpossumError } from '@shared/errors';

export function parseConfigurationYaml(source: string): PortableConfiguration {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new OpossumError(
      'VALIDATION',
      `YAML could not be parsed: ${error instanceof Error ? error.message : 'invalid YAML'}`,
    );
  }
  const result = portableConfigurationSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new OpossumError(
      'VALIDATION',
      `Configuration has ${details.length} validation error${details.length === 1 ? '' : 's'}.`,
      details,
    );
  }
  return result.data;
}

export function previewImport(
  filePath: string,
  incoming: PortableConfiguration,
  active: TargetConfig[],
  allKnown: TargetConfig[],
): ImportPreview {
  const activeById = new Map(active.map((target) => [target.id, target]));
  const knownById = new Map(allKnown.map((target) => [target.id, target]));
  let newTargets = 0;
  let matchingTargets = 0;
  let newChecks = 0;
  let matchingChecks = 0;
  const conflicts: ImportConflict[] = [];
  for (const target of incoming.targets) {
    const known = knownById.get(target.id);
    const current = activeById.get(target.id);
    if (known) {
      matchingTargets += 1;
      if (!current)
        conflicts.push({
          kind: 'target',
          targetId: target.id,
          reason: 'Matches a previously deleted target',
        });
      const knownChecks = new Set(known.checks.map((check) => check.id));
      for (const check of target.checks) {
        if (knownChecks.has(check.id)) matchingChecks += 1;
        else newChecks += 1;
      }
    } else {
      newTargets += 1;
      newChecks += target.checks.length;
    }
  }
  return {
    filePath,
    newTargets,
    matchingTargets,
    newChecks,
    matchingChecks,
    conflicts,
    configuration: {
      applicationVersion: incoming.application_version,
      exportedAt: incoming.exported_at,
    },
  };
}
