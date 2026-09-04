# OPOSSUM

**Operational Polling and Observation of Systems, Services, Uptime, and Machines**

OPOSSUM is a local, on-demand Windows endpoint monitor. Open it to check hosts, TCP ports, and HTTP applications; close the main window to stop every check and end the monitoring session. It is deliberately not a service, tray application, network dashboard, or SLA platform.

## What the MVP does

- Starts enabled checks immediately and repeats them at configured intervals while the window is open.
- Runs ICMP ping, TCP connection, and HTTP/HTTPS response checks.
- Enforces global concurrency and prevents the same check from overlapping itself.
- Supports manual runs and session-only pause/resume controls. Pausing everything keeps individually paused checks paused when monitoring resumes.
- Schedules each check from the start of its previous run, so a slow or failing endpoint does not stretch its own interval.
- Optionally requires several consecutive failures before a check turns FAIL (`failures_before_fail`), so one lost packet does not create a new history interval.
- Stores configuration, sessions, compressed status intervals, and last-known results in local SQLite.
- Shows previous sessions and explicitly renders time between sessions as **Not monitoring**.
- Imports and exports deterministic YAML configuration without exporting results or resolved secrets.
- Bounds history by age and database size, with previews for manual destructive actions.
- Runs without Python, Docker, a database server, a separately installed runtime, or normal-operation internet access.

## Install and run

The primary release artifact is `OPOSSUM-<version>.<build>-portable-x64.exe`, attached to each [GitHub Release](https://github.com/mwen-ner-sten/opossum/releases). The first three numbers are the semantic version; the fourth is the commit count of the build. It requires no administrator rights or installer. This MVP build is unsigned, so Windows SmartScreen may show an unrecognized-app warning until a signing certificate is added to a future release.

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

Use **Data & history → Open data folder** or the File menu to open this location. If `opossum.yaml` is beside a packaged portable executable on first launch, OPOSSUM offers to preview and import it. The source file is never treated as live configuration. The first-run screen can also load the bundled example configuration, which uses documentation addresses you then edit.

Only one OPOSSUM instance runs at a time; launching a second copy focuses the existing window instead of opening a second session against the same database.

## Configure targets and checks

Use **Configuration → Add target**. A target has a stable ID, display name, hostname or IP address, optional group and description, and one or more checks. IDs use letters, numbers, dots, underscores, and dashes.

Hosts must be an IPv4 address, an IPv6 address, or a valid hostname; values that `ping.exe` could read as a flag are rejected. Checks inherit the application interval and timeout unless overridden, and every check may set `failures_before_fail` (1 to 10, default 1):

- **Ping** sends one Windows ICMP echo request and records a reliably parsed round-trip time. A reply must carry a TTL to count as PASS; "Destination host unreachable" answers from a router are reported as failures even though `ping.exe` exits successfully for them.
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

## Dependencies: don't knock on a door you know is closed

Any check may name precursors with `depends_on`. When a precursor is currently failing, the dependent check is recorded as **Blocked** (a FAIL with a `blocked` diagnostic) without touching the network, so a dead site costs one ping per interval instead of a ping, several TCP timeouts, and an HTTP timeout. The moment the precursor passes again, blocked checks run immediately rather than waiting for their next interval. Checks that are not named as precursors, such as an SSH or Modbus port, can fail freely without blocking anything.

```yaml
checks:
  - { id: host-ping, name: Host ping, type: ping }
  - { id: rdp, name: Remote Desktop, type: tcp, port: 3389, depends_on: [host-ping] }
  - { id: modbus, name: Modbus, type: tcp, port: 502, depends_on: [host-ping] }
  - { id: ebo-web, name: EBO WebStation, type: http, url: 'https://{{host}}/', depends_on: [rdp] }
```

On first run a dependent waits until its precursors have produced a result. Precursors that are paused never block. Cycles and references to unknown checks are rejected when the target or template is saved. In the editor, each check has a _Runs only after these pass_ list covering the target's own and inherited checks.

## Backoff and capacity

**Failure backoff.** After a check crosses its `failures_before_fail` threshold, every further failure doubles its interval, up to `failure_backoff_max_seconds` (default 600, 0 disables). A site that has been down for an hour is probed every ten minutes instead of every minute; the first success restores the normal interval. The monitor marks such checks with _backoff_ and the detail panel shows the current spacing.

**Capacity check.** The default interval is 60 seconds. **Data & history → Monitoring defaults** shows a capacity assessment that multiplies each check's timeout by its launch rate to estimate how many checks would be in flight if everything timed out at once, and compares that with `max_concurrent_checks`. A warning appears in the top bar when headroom is thin, with a suggested concurrency (or a longer default interval when the 200-check cap would not be enough). The import builder shows the same projection for the configuration as it would look after the import.

## Templates: one definition, many sites

A template is a named set of checks whose text fields may contain placeholders. Link a target to a template and it inherits every check with the placeholders filled in for that target, so monitoring EBO on a hundred sites means one template plus a hundred hosts, not a hundred hand-built check lists. Edit the template later and every linked target is regenerated in place; check identity and history are preserved.

| Placeholder                       | Value                                                        |
| --------------------------------- | ------------------------------------------------------------ |
| `{{host}}`                        | The target's hostname or IP                                  |
| `{{name}}`, `{{id}}`, `{{group}}` | The target's display name, ID, and group                     |
| `{{vars.<key>}}`                  | A per-target variable, for sites that differ in port or path |

Create templates under **Configuration → Templates**. In the target editor, pick a linked template, fill any variables it needs, and add target-specific checks alongside the inherited ones. An own check with the same ID as an inherited check overrides it. Inherited checks show as _From template_ and are read-only on the target.

In YAML a template is declared once and referenced by ID:

```yaml
templates:
  - id: ebo-site
    name: EBO site server
    checks:
      - { id: host-ping, name: Host ping, type: ping }
      - {
          id: ebo-web,
          name: EBO WebStation,
          type: http,
          url: 'https://{{host}}:{{vars.web_port}}/',
          verify_tls: false,
        }
targets:
  - id: den-bms-01
    name: Denver BMS Server 01
    host: 10.20.31.40
    template: ebo-site
    vars: { web_port: '443' }
    checks: []
```

Exports contain only own checks plus the templates the exported targets reference.

## Import builder: spreadsheets and other lists

**Import** accepts more than OPOSSUM YAML. Choose a CSV, TSV, XLSX, JSON, XML, or plain-text file, or use **Configuration → Paste list** to paste rows copied from a spreadsheet, and the import builder opens:

1. **Map columns.** Headings such as _IP Address_, _Site Name_, _Region_, or _Template_ are detected automatically; adjust the mapping if needed. Only the host column is required. Missing names fall back to the host and IDs are generated from the name (with an optional prefix).
2. **Choose a template** for every row, or map a column that names one per row. Unmapped columns can be exposed to the template as `{{vars.<name>}}`, for example a _Web Port_ column becomes `{{vars.web_port}}`. For every variable the template reads you can map a column, type a value to use for every row (or as the fallback for blank cells), or leave it: rows still missing a variable import **partially**, meaning the inherited checks that read it stay inactive and the target shows a _Needs …_ badge in Configuration and on the monitor until you set the value in the target editor.
3. **Review** the generated targets, the rows that were skipped and why, and how the result merges with what is already stored. Then **Add** new targets only or **Replace** the active set.

**Remote Desktop Manager.** A Devolutions RDM JSON export (the `Connections` list) is recognised automatically: folder entries become the group of their children, the host is lifted from `Terminal.Host`, `Host`, or `Url`, and a _Connection type_ column names the protocol (SSH shell, RDP, Web browser, ...) so it can be exposed as a variable or used to choose a template per row. Sample files for every format, including an RDM export, live under [`samples/`](samples/README.md).

JSON, YAML, and XML files may wrap their record list (`sites:`, `targets:`, a repeated element); nested fields are flattened to dotted column names. A file that already is a full OPOSSUM configuration (it has `format_version`) skips the builder and uses the normal preview below. Files are limited to 25 MiB and 5,000 rows.

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

Bounded maintenance runs shortly after startup (after the first checks are queued) and every six hours in a long session. It yields to the event loop between batches, keeps the last 200 maintenance summaries, and only raises a notice when it actually removed something or failed. It first trims or removes eligible closed history older than the age cutoff. If the SQLite database plus WAL/SHM files still exceed the size guard, it removes oldest closed sessions toward 85% of the limit. Active configuration, the current session, and last-known state are protected. If current-session data alone exceeds the limit, OPOSSUM warns and keeps operating.

The **Data & history** workspace can:

- preview and purge history older than a chosen number of days;
- preview and purge one target or check;
- clear all history while optionally retaining last-known state;
- delete selected closed sessions;
- remove soft-deleted definitions only when no history or last-known state references them;
- checkpoint the WAL, run `PRAGMA optimize`, and perform bounded incremental vacuuming;
- explicitly run a full vacuum, which rewrites the database file and may temporarily require additional disk space. Checks keep running; SQLite serialises the work on the single connection.

Deleting a session that still supplies a check's last-known result is allowed; the result is kept and simply no longer points at a session. Configuration is not deleted by history actions. A migration that changes stored data creates a recoverable database backup first, retaining the latest three migration backups.

## Development

Requirements: Windows x64 and Node.js 24 or a compatible supported Node release.

```powershell
npm install
npm run dev
```

Quality checks:

```powershell
npm run check          # format:check + lint + typecheck + unit/integration tests
npm run test:coverage  # same tests with the 80% coverage gate used in CI
npm run test:e2e       # builds, then drives the packaged renderer with Playwright
```

Tests use temporary SQLite databases, a mocked `ping.exe`, and local TCP/HTTP servers. They do not require public internet access. The GitHub Actions workflow in `.github/workflows/ci.yml` runs the same steps on `windows-latest` and uploads the portable build.

Build the portable application:

```powershell
npm run build:portable
```

The artifact is written to `release\`. Electron Builder rebuilds the native SQLite binding for Electron and packages the runtime with the application.

### Branches, pull requests, and releases

- `dev` is the integration branch and the default. Branch from it (`feat/...`, `fix/...`, `chore/...`) and open pull requests back into it. Pull requests into `dev` are squash-merged, so give each one a conventional-commit title.
- `main` only ever receives `dev` (as a merge commit, so both branches share history) and the automated release pull request.
- CI runs on every pull request and on pushes to both branches: format, lint, and typecheck on Linux, and the unit and integration tests, Electron build, Playwright end-to-end suite, and a portable exe on Windows. `node_modules` and the Electron downloads are cached against the lockfile, so unchanged dependencies install in seconds. The exe is uploaded as a workflow artifact named `opossum-portable-<version>.<build>-<sha>`.
- Versions follow semver and are chosen by [release-please](https://github.com/googleapis/release-please) from commit prefixes: `feat:` bumps minor, `fix:` bumps patch, and a `!` or `BREAKING CHANGE:` footer bumps major. Because the YAML configuration and import templates are a user-facing contract, a major bump means existing configuration may need migration.
- Merging `dev` into `main` opens (or refreshes) a release pull request with the next version and changelog. Merging that creates the tag and GitHub Release and attaches the portable exe. A follow-up pull request syncs `main` back into `dev`.
- The fourth version position (`0.1.0.142`) is the commit count of the built branch, injected by CI through `BUILD_NUMBER`. Local builds show `-local` instead.

## Common failures

- **Host not found:** verify DNS resolution from Windows and check the target host spelling.
- **Ping executable unavailable:** confirm `%SystemRoot%\System32\PING.EXE` exists and is permitted by endpoint controls.
- **TCP connection refused:** the host answered but nothing accepted the configured port.
- **HTTP timeout:** increase the per-check timeout only after confirming the endpoint is expected to respond slowly.
- **TLS certificate validation failed:** fix the certificate trust/name problem. Disable verification only for endpoints where that risk is understood.
- **HTTP connection refused / Host not found / TLS certificate validation failed:** these are now distinguished from generic network errors; the diagnostic names the cause.
- **Authentication variables are not set:** launch OPOSSUM from an environment containing the configured username/password variables.
- **Database writes failing:** the header turns red after three consecutive failed writes and results are shown live without being saved. Check free disk space and `logs\opossum.log`, then restart OPOSSUM.
- **Database is newer than this build:** a database written by a later OPOSSUM refuses to open. Upgrade, or restore a backup from `backups\`.
- **Database cannot be opened or migrated:** close other tools using the database, inspect `logs\opossum.log`, and preserve the database plus `backups\` before attempting recovery.
- **Database remains above its size guard:** the current session or SQLite free pages may account for the size. Run bounded optimization or explicitly choose full vacuum.

## Security and privacy

The renderer is sandboxed, has no Node.js integration, loads only packaged assets, and communicates through a narrow validated context bridge. OPOSSUM does not execute user scripts or construct shell command strings. Native ping receives validated arguments without a shell. It does not include telemetry, cloud synchronization, notifications, or a network-accessible API.

## License

OPOSSUM is released under the [MIT License](LICENSE). Copyright (c) 2026 Mike Wennersten.

Direct production dependencies were reviewed for permissive-license compatibility for the MVP. Their own license files remain included in the packaged dependency distribution; no selected direct dependency currently requires a separate project-level notice file.
