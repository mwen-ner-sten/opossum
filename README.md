# OPOSSUM

**Operational Polling and Observation of Systems, Services, Uptime, and Machines**

OPOSSUM is a local, on-demand Windows endpoint monitor. Open it to check hosts, TCP ports, and HTTP applications; close the main window to stop every check and end the monitoring session. It is deliberately not a service, tray application, network dashboard, or SLA platform.

## What the MVP does

- Starts enabled checks immediately and repeats them at configured intervals while the window is open.
- Runs ICMP ping, TCP connection, and HTTP/HTTPS response checks.
- Enforces global concurrency and prevents the same check from overlapping itself.
- Supports manual runs and session-only pause/resume controls.
- Stores configuration, sessions, compressed status intervals, and last-known results in local SQLite.
- Shows previous sessions and explicitly renders time between sessions as **Not monitoring**.
- Imports and exports deterministic YAML configuration without exporting results or resolved secrets.
- Bounds history by age and database size, with previews for manual destructive actions.
- Runs without Python, Docker, a database server, a separately installed runtime, or normal-operation internet access.

## Install and run

The primary release artifact is `OPOSSUM-0.1.0-portable-x64.exe`. It requires no administrator rights or installer. This MVP build is unsigned, so Windows SmartScreen may show an unrecognized-app warning until a signing certificate is added to a future release.

All application data remains under:

```text
%LOCALAPPDATA%\OPOSSUM\
  opossum.db
  opossum.db-wal
  opossum.db-shm
  preferences.json
  backups\
  logs\
```

Use **Data & history → Open data folder** or the File menu to open this location. If `opossum.yaml` is beside a packaged portable executable on first launch, OPOSSUM offers to preview and import it. The source file is never treated as live configuration.

## Configure targets and checks

Use **Configuration → Add target**. A target has a stable ID, display name, hostname or IP address, optional group and description, and one or more checks. IDs use letters, numbers, dots, underscores, and dashes.

Checks inherit the application interval and timeout unless overridden:

- **Ping** sends one Windows ICMP echo request and records a reliably parsed round-trip time.
- **TCP** resolves the target host and opens then immediately closes the configured port.
- **HTTP** supports GET or HEAD, status values/lists/ranges, required or forbidden case-sensitive text, static non-secret headers, redirects, optional TLS-verification override, and Basic or Digest authentication.

HTTP content matching reads at most 1 MiB and never saves the response body. Disabling TLS verification is visible in result details.

### Credentials

Authentication configuration stores environment-variable names, never credential values:

```yaml
auth:
  type: digest
  username_env: OPOSSUM_EBO_USERNAME
  password_env: OPOSSUM_EBO_PASSWORD
```

Define those variables in the environment that launches OPOSSUM. Resolved values are never exported, written to status history, sent to the renderer, or intentionally logged. Authorization, cookie, and proxy-authorization headers are rejected from static header configuration.

## YAML import and export

See [`opossum.example.yaml`](opossum.example.yaml) for the complete portable format.

Every import is parsed and validated before a write begins. The preview reports new, matching, and conflicting targets/checks. Validation errors identify the YAML path that failed.

- **Replace active configuration** updates matching portable IDs in place, restores matching soft-deleted identities, adds new IDs, and soft-deletes active items absent from the file. Internal identities and history remain attached.
- **Add only new items** adds targets whose IDs have never existed locally. Existing and soft-deleted identities are left untouched.

A canceled or invalid import changes nothing. A successful import is transactional and newly enabled checks are scheduled immediately.

Exports include active configuration and application defaults only. They are sorted by target and check ID for useful source-control diffs. Use the top toolbar for all targets or **Configuration → Export target** for one target.

## Sessions, history, and availability

Each launch creates a new monitoring session with a 30-second heartbeat. Clean shutdown closes active status intervals after checks are canceled or given a short grace period. On the next launch, an interrupted session ends shortly after its final heartbeat and is marked as unclean.

OPOSSUM stores status intervals instead of one row for every successful poll. An interval continues while status and diagnostic category remain stable, accumulating observation count and duration statistics. A transition or materially different failure category begins a new interval.

Before a new session has a result, the interface may show the prior result with a **Last known** label. It is never presented as current status. Time between sessions is **Not monitoring**, not pass or fail.

**Observed availability** is pass time divided by pass plus fail time. Unknown, paused, and not-monitoring time is excluded. It describes only observations made by this foreground utility and is not an SLA measurement.

## Retention and maintenance

Defaults are 180 days and 250 MiB. Set either value to `0` to disable that guard.

Bounded maintenance runs at startup and every six hours in a long session. It first trims or removes eligible closed history older than the age cutoff. If the SQLite database plus WAL/SHM files still exceed the size guard, it removes oldest closed sessions toward 85% of the limit. Active configuration, the current session, and last-known state are protected. If current-session data alone exceeds the limit, OPOSSUM warns and keeps operating.

The **Data & history** workspace can:

- preview and purge history older than a chosen number of days;
- preview and purge one target or check;
- clear all history while optionally retaining last-known state;
- delete selected closed sessions;
- remove soft-deleted definitions only when no history or last-known state references them;
- checkpoint the WAL, run `PRAGMA optimize`, and perform bounded incremental vacuuming;
- explicitly run a full vacuum, which pauses new checks and may temporarily require additional disk space.

Configuration is not deleted by history actions. A migration that changes stored data creates a recoverable database backup first, retaining the latest three migration backups.

## Development

Requirements: Windows x64 and Node.js 24 or a compatible supported Node release.

```powershell
npm install
npm run dev
```

Quality checks:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

Tests use temporary SQLite databases, process mocks, and local TCP/HTTP servers. They do not require public internet access.

Build the portable application:

```powershell
npm run build:portable
```

The artifact is written to `release\`. Electron Builder rebuilds the native SQLite binding for Electron and packages the runtime with the application.

## Common failures

- **Host not found:** verify DNS resolution from Windows and check the target host spelling.
- **Ping executable unavailable:** confirm `%SystemRoot%\System32\PING.EXE` exists and is permitted by endpoint controls.
- **TCP connection refused:** the host answered but nothing accepted the configured port.
- **HTTP timeout:** increase the per-check timeout only after confirming the endpoint is expected to respond slowly.
- **TLS certificate validation failed:** fix the certificate trust/name problem. Disable verification only for endpoints where that risk is understood.
- **Authentication variables are not set:** launch OPOSSUM from an environment containing the configured username/password variables.
- **Database cannot be opened or migrated:** close other tools using the database, inspect `logs\opossum.log`, and preserve the database plus `backups\` before attempting recovery.
- **Database remains above its size guard:** the current session or SQLite free pages may account for the size. Run bounded optimization or explicitly choose full vacuum.

## Security and privacy

The renderer is sandboxed, has no Node.js integration, loads only packaged assets, and communicates through a narrow validated context bridge. OPOSSUM does not execute user scripts or construct shell command strings. Native ping receives validated arguments without a shell. It does not include telemetry, cloud synchronization, notifications, or a network-accessible API.

## License

OPOSSUM is released under the [MIT License](LICENSE). Copyright (c) 2026 Mike Wennersten.

Direct production dependencies were reviewed for permissive-license compatibility for the MVP. Their own license files remain included in the packaged dependency distribution; no selected direct dependency currently requires a separate project-level notice file.
