declare const __BUILD_NUMBER__: string | undefined;

/** Fourth version position: commit count on the built branch, injected at build time by CI. */
const buildNumber =
  typeof __BUILD_NUMBER__ === 'string' && __BUILD_NUMBER__.length > 0
    ? __BUILD_NUMBER__
    : undefined;

// The semantic version is bumped by release-please; keep it in sync with package.json.
const version = '0.1.0'; // x-release-please-version

export const PRODUCT = {
  name: 'OPOSSUM',
  fullName: 'Operational Polling and Observation of Systems, Services, Uptime, and Machines',
  appId: 'com.mikewennersten.opossum',
  version,
  /** `major.minor.patch.build` when built by CI, otherwise `major.minor.patch-local`. */
  buildVersion: buildNumber ? `${version}.${buildNumber}` : `${version}-local`,
  dataDirectory: 'OPOSSUM',
  copyright: 'Copyright (c) 2026 Mike Wennersten',
  license: 'MIT License',
} as const;
