# OPOSSUM

## On-demand endpoint status monitor — MVP specification

**Name:** OPOSSUM  
**Expansion:** Operational Polling and Observation of Systems, Services, Uptime, and Machines  
**Purpose:** Open the application, immediately check a set of endpoints, and compare their live status with lightweight history from earlier sessions.

## 1. Product intent

OPOSSUM is a small Windows desktop utility for day-to-day operations work. It answers three practical questions:

1. Can the host be reached?
2. Is the required TCP port accepting connections?
3. Is the web application responding correctly?

It is not intended to replace Zabbix, Uptime Kuma, or another continuously running monitoring platform. It is an on-demand operator tool: monitoring exists only while `opossum.exe` is running.

## 2. MVP boundaries

- Windows is the primary platform.
- Launching OPOSSUM opens the interface and immediately begins checking enabled endpoints.
- Checks repeat at their configured intervals while the application is open.
- Closing the main window exits the application and stops all checks.
- No Windows service, background process, system-tray mode, startup task, or always-on component is required.
- Configuration, sessions, status history, and the last known result for each check are stored in a local SQLite database.
- When OPOSSUM is reopened, it restores the configured targets and displays their last known historical state while clearly distinguishing it from a current-session result.
- Historical storage is optimized around status intervals and transitions rather than retaining every successful poll forever.
- Configuration can be exported to and imported from a portable YAML file for sharing between operators.
- The application is single-user and completely local.
- Normal operation must not require internet access.
- MVP statuses are `UNKNOWN`, `CHECKING`, `PASS`, `FAIL`, and `PAUSED`.

## 3. Technology choice

Use Electron with TypeScript and React.

Electron is acceptable here even though it has a larger package and memory footprint than a native UI toolkit. OPOSSUM only consumes resources while deliberately open, and Electron provides the most direct route to a polished, responsive interface and portable Windows packaging.

Recommended stack:

- Electron
- TypeScript with strict mode enabled
- React and Vite for the renderer
- A small set of accessible UI primitives rather than a generic admin template
- Node `net` and `dns` APIs for TCP and name-resolution behavior
- Undici or Electron/Node's maintained HTTP implementation for HTTP checks
- Native operating-system `ping` invoked through a tightly controlled child process
- SQLite through a maintained binding such as `better-sqlite3`
- A maintained YAML parser plus runtime schema validation such as Zod
- Vitest for core tests
- Playwright for a few critical Electron interaction tests
- Electron Builder or Electron Forge for Windows packaging

Do not require Python, Docker, a web server, Redis, PostgreSQL, or an external service.

## 4. User experience

### First launch

Create the local database automatically and show a polished first-run screen that offers:

- `Add first target`
- `Import configuration`
- `Load example configuration`
- a short explanation of what OPOSSUM checks

The database is the authoritative working configuration. Imported files are validated and copied into the database; OPOSSUM does not continue reading or modifying the imported source file.

### Normal launch

1. Open the main window.
2. Open and migrate the local database.
3. Restore targets, checks, prior sessions, and each check's last known result.
4. Render the last known state immediately with a visible `Historical` or `Last known` label.
5. Queue the initial checks without waiting for the user.
6. Replace historical state with current-session state as checks complete.
7. Continue running checks at their configured intervals until the application closes.

### Operator actions

- Run one check now
- Run every check for one target now
- Run all checks now
- Pause or resume one check for the current session
- Pause or resume all checks for the current session
- Add, edit, duplicate, enable/disable, and delete targets and checks
- Export all configuration or selected targets to a shareable YAML file
- Import a YAML configuration with validation and preview
- View the current or a previous monitoring session
- View an up/down/offline timeline for a target or check
- Copy a result summary or diagnostic error

Manual and scheduled executions must use the same checking code.

## 5. Configuration

Store active configuration in SQLite. The interface must provide basic forms for managing targets and checks; users should not have to edit the database directly.

Use YAML as the portable import/export format. Include a complete `opossum.example.yaml` in the repository. Exported files contain configuration only—not results, sessions, logs, or secrets.

```yaml
format_version: 1
exported_at: 2026-09-03T18:42:00Z
application_version: 0.1.0

app:
  default_interval_seconds: 30
  default_timeout_seconds: 5
  max_concurrent_checks: 20
  history_max_age_days: 180
  history_max_database_mb: 250
  maintenance_on_startup: true

targets:
  - id: chi-bms-01
    name: Chicago BMS Server 01
    host: 10.20.30.40
    group: Chicago
    description: Primary EBO application server
    checks:
      - id: host-ping
        name: Host ping
        type: ping

      - id: rdp
        name: Remote Desktop
        type: tcp
        port: 3389

      - id: ebo-web
        name: EBO WebStation
        type: http
        url: https://10.20.30.40/
        expected_status: [200, 401]
        verify_tls: false
        timeout_seconds: 10

  - id: chi-pme-01
    name: Chicago PME Server 01
    host: pme01.example.internal
    group: Chicago
    checks:
      - id: host-ping
        name: Host ping
        type: ping
        interval_seconds: 15

      - id: pme-web
        name: PME Web Application
        type: http
        url: https://pme01.example.internal/Web/
        expected_status: 200-399
        contains: Power Monitoring Expert
```

Target fields:

- `id`: required stable identifier
- `name`: required display name
- `host`: required hostname or IP address
- `group`: optional display group
- `description`: optional operator note
- `enabled`: optional, defaults to `true`
- `checks`: one or more checks

Common check fields:

- `id`: required and unique within its target
- `name`: required display name
- `type`: `ping`, `tcp`, or `http`
- `enabled`: optional, defaults to `true`
- `interval_seconds`: optional, inherits the application default
- `timeout_seconds`: optional, inherits the application default
- `tags`: optional list of strings

Configuration behavior:

- Validate target/check forms before saving and validate an entire imported file before writing anything.
- Identify the exact target, check, and field in import validation errors.
- Reject duplicate target IDs and duplicate check IDs within a target.
- Configuration changes use database transactions and become active immediately.
- Editing a check must not rewrite or detach its historical records; stable internal IDs preserve history across display-name, host, URL, interval, and group changes.
- Deleting a target or check requires confirmation and performs a soft delete so existing history remains viewable.
- Export all active configuration by default; optionally export selected targets.
- Export in deterministic order so two exports can be meaningfully compared in source control.
- Include `format_version`, export timestamp, application version, app defaults, targets, and checks.
- Never export resolved passwords, authorization headers, cookies, or environment-variable values.
- Import presents a preview with counts for new, matching, and conflicting targets/checks.
- MVP import modes are `Replace active configuration` and `Add only new items`. Do not silently overwrite conflicts.
- A failed or canceled import leaves the database unchanged.
- A successful import immediately schedules newly enabled checks.

## 6. SQLite persistence and history

Default database location:

```text
%LOCALAPPDATA%\OPOSSUM\opossum.db
```

Use schema migrations, foreign keys, parameterized queries, transactions, and WAL mode. The database must remain local and must not require a database server.

Minimum logical entities:

- `app_settings`: UI and monitoring defaults
- `targets`: active and soft-deleted target definitions
- `checks`: active and soft-deleted check definitions
- `sessions`: one record for each period when OPOSSUM was open and monitoring
- `status_intervals`: compressed historical up/down/unknown intervals
- `check_last_state`: latest completed result for fast startup restoration
- `maintenance_runs`: bounded summaries of purge, checkpoint, and optimization operations
- `schema_version`: current migration version

### Sessions

- Create a new session every time OPOSSUM starts monitoring.
- Store `started_at`, `ended_at`, `last_heartbeat_at`, application version, and whether shutdown was clean.
- Update the session heartbeat approximately every 30 seconds while running.
- On a clean close, set `ended_at` after active checks are canceled or given a short shutdown grace period.
- If a prior session has no clean end, treat its monitored period as ending shortly after its final heartbeat. Do not imply monitoring continued after the process stopped.
- Reopening OPOSSUM creates a new session; it does not append new results to the old session.

### Lightweight status history

Persist compressed status intervals rather than an unbounded row for every poll:

- Start a new interval when a check first completes in a session.
- Continue updating the active interval while its status and diagnostic category remain unchanged.
- Start a new interval when status changes, such as `PASS` to `FAIL`, or when a failure category materially changes, such as `timeout` to `connection refused`.
- Close every active interval when the application session ends.
- Store interval start, interval end, last observation time, status, diagnostic category, observation count, latest summary, and aggregate duration statistics (`min`, `max`, and average).
- Store timestamps in UTC and render them in the user's local time.
- `CHECKING` is transient UI state and does not become a persisted availability interval.
- `PAUSED` and `UNKNOWN` may be persisted so the timeline can explain why no up/down result exists.

This design must preserve whether a check was working during earlier OPOSSUM sessions while keeping long periods of unchanged status compact.

### Last known state restoration

- Persist the last completed result for each check separately from the current live state.
- On launch, show that result immediately with its timestamp and an explicit `Last known` label.
- Never present a prior-session result as current `PASS` or `FAIL`.
- Once a check completes in the new session, replace the last-known presentation with its current-session state.
- Offline gaps between application sessions are displayed as `Not monitoring`, not as up or down.

### Timeline and observed availability

- Provide timeline ranges for `Current session`, `Previous session`, `24 hours`, `7 days`, `30 days`, and `All history`.
- Render `PASS`, `FAIL`, `UNKNOWN/PAUSED`, and `Not monitoring` as visually distinct segments with text/tooltips, not color alone.
- Hovering or focusing a segment shows start, end, duration, sample count, status, and latest diagnostic summary.
- A target timeline may aggregate its checks using the target's worst-state rule.
- For a selected time range, optionally show `Observed availability`: time in `PASS` divided by time in `PASS + FAIL`.
- Exclude `Not monitoring`, `UNKNOWN`, and `PAUSED` time from observed availability.
- Label this clearly as observed data, not an SLA measurement.

### Database safety

- Create the database and parent directory automatically.
- Apply migrations atomically and create a recoverable database backup before a migration that changes stored data.
- Configuration import and configuration editing must be transactional.
- If the database cannot be opened or migrated, show a recovery-oriented error and do not start checks.
- Provide an `Open data folder` action.

### Retention and database-size controls

Defaults:

- `history_max_age_days`: `180`; `0` disables age-based automatic purging
- `history_max_database_mb`: `250`; `0` disables the database-size guard
- `maintenance_on_startup`: `true`
- long-session maintenance interval: every 6 hours while OPOSSUM remains open
- size-reduction target after enforcing the size guard: 85% of the configured maximum

Rules:

- Retention applies to closed historical sessions and their status intervals, never to active configuration, the current session, or `check_last_state`.
- At startup, run a bounded maintenance pass before loading large history views. Do not delay initial live checks for a long full-database rebuild.
- During a long-running session, repeat the bounded maintenance pass every six hours.
- Age-based purge removes history older than the cutoff in batches. If an interval crosses the cutoff, trim it to the cutoff instead of deleting the entire interval.
- Measure the size guard using the combined on-disk size of the main database and its SQLite WAL/SHM sidecar files.
- First enforce maximum age. If storage still exceeds `history_max_database_mb`, remove the oldest closed sessions in bounded batches until storage is at or below 85% of the configured maximum.
- Never purge part of the current session to meet a size limit. If the current session alone exceeds the limit, warn the user and continue operating.
- Every purge is transactional by batch and records a maintenance summary containing start/end time, reason, cutoff, rows removed, sessions removed, and any error. Do not recursively write maintenance-log records into the history being purged.
- Purging history must not renumber or reuse target, check, or session identifiers.

### Manual history and maintenance tools

Provide a `Data & history` settings page showing:

- main database, WAL, and total disk usage
- target, check, session, and status-interval counts
- oldest and newest retained history timestamps
- configured age and size limits
- last automatic-maintenance result

Manual actions:

- `Purge history older than…` with a date or number of days
- `Delete selected sessions`
- `Purge history for selected target/check`
- `Clear all history`
- `Remove deleted items with no remaining history`
- `Optimize database`
- `Open data folder`

Safety and behavior:

- Every destructive action shows a preview with the affected time range and estimated session/interval counts before confirmation.
- Purge actions delete history only unless the action explicitly says it also removes unused soft-deleted definitions.
- `Clear all history` preserves configuration, settings, and last-known check state by default. Offer a separate checkbox to clear last-known state.
- A failed or canceled purge leaves committed configuration intact and reports whether any earlier bounded batch had already completed.
- Initialize new databases with `auto_vacuum=INCREMENTAL` before creating application tables.
- Normal maintenance should run `PRAGMA optimize`, checkpoint/truncate the WAL when safe, and perform a bounded incremental vacuum after deletion.
- Do not run a blocking full `VACUUM` automatically.
- `Optimize database` may offer a full vacuum as an explicit operation. Explain that it may temporarily require additional disk space, pause new checks while it runs, show progress/state, and resume checks afterward.

## 7. Check types

### Ping

- Run one ICMP echo attempt against the target host.
- Apply the configured timeout.
- Pass when a reply is received.
- Record round-trip time when it can be parsed reliably.
- Report timeout, name-resolution failure, missing executable, and other failures without crashing the application.

Examples:

- `Reply in 18 ms`
- `Timed out after 2.0 s`
- `Host not found`

### TCP port

Additional field:

- `port`: required integer from 1 through 65535

Behavior:

- Resolve the target host and attempt a TCP connection.
- Pass when connected within the timeout, then immediately close the socket.
- Distinguish timeout, name-resolution failure, connection refused, and other socket errors.

Examples:

- `TCP 443 connected in 24 ms`
- `TCP 502 connection refused`
- `TCP 3389 timed out after 3.0 s`

### HTTP/HTTPS

Fields:

- `url`: required complete URL
- `method`: `GET` or `HEAD`, defaults to `GET`
- `expected_status`: integer, list of integers, or range such as `200-399`; defaults to `200-399`
- `contains`: optional case-sensitive required response substring
- `not_contains`: optional case-sensitive forbidden response substring
- `headers`: optional static non-secret headers
- `verify_tls`: defaults to `true`
- `follow_redirects`: defaults to `true`
- `auth`: optional Basic or Digest authentication configuration

Behavior:

- Pass only if the request finishes within the timeout, returns an expected status, and satisfies configured content rules.
- Record status, final URL, total duration, and response size when available.
- Read no more than 1 MiB of response content for matching.
- Do not retain or display full response bodies.
- TLS verification is enabled by default.
- If verification is disabled, show `TLS verification disabled` in the result details.

Credentials must reference environment variables rather than appearing directly in YAML:

```yaml
auth:
  type: digest
  username_env: OPOSSUM_EBO_USERNAME
  password_env: OPOSSUM_EBO_PASSWORD
```

Examples:

- `HTTP 200 in 142 ms`
- `HTTP 503; expected 200-399`
- `HTTP 200; required text not found`
- `TLS certificate validation failed`

## 8. Execution and status rules

- Queue initial checks within one second of loading a valid configuration.
- Enforce the global concurrency limit.
- Do not execute the same check concurrently with itself.
- A manual run requested during an active run may queue one follow-up run; repeated clicks must not create an unbounded queue.
- One slow, failed, or malformed endpoint must not block other checks or crash the main process.
- Each check publishes status changes to the renderer as they occur.
- `UNKNOWN`: the check has not completed during this application session and has no current result.
- `CHECKING`: a check is currently executing.
- `PASS`: its latest completed execution passed.
- `FAIL`: its latest completed execution failed.
- `PAUSED`: it is disabled in configuration or paused for the current session.
- A target's overall status is its worst enabled-check state: `FAIL`, `CHECKING`, `UNKNOWN`, then `PASS`.
- Persist completed observations through the compressed status-interval model.
- Preserve last known state and prior sessions across application restarts.
- Do not treat time when OPOSSUM was closed as downtime or uptime.
- Do not calculate or display SLA availability; only the explicitly defined observed-availability metric is permitted.

## 9. Modern interface requirements

Visual polish is an MVP requirement. The application must not resemble a default Bootstrap page, generic admin template, or unfinished internal proof of concept.

Visual direction:

- Dense, calm operations-console aesthetic
- Neutral charcoal/slate surfaces with restrained semantic colors
- Green, amber, red, blue, and gray are reserved for status and interaction meaning
- Modern sans-serif typography with tabular numerals for durations and timestamps
- Consistent spacing, alignment, border radius, icon sizing, and control height
- Subtle borders, elevation, hover states, and 100–200 ms state transitions
- Avoid gradients, glassmorphism, oversized cards, excessive empty space, and novelty animation
- Light and dark themes, defaulting to the operating-system preference
- Persist the selected theme, window position, window size, filters, and collapsed groups
- A restrained possum silhouette or face may be used as the product mark; it must not dominate the operational interface

Main screen:

- OPOSSUM name and product mark
- total counts for pass, fail, checking, unknown, and paused
- current session start time and database health
- `Run all`, `Pause all`, configuration, import, and export actions
- filter by group, status, check type, tag, or free-text search
- failures first by default, followed by checking/unknown and then passing checks
- collapsible target groups
- rows showing target, host, check name/type, status icon and text, diagnostic summary, duration, last-check time, and next-check time
- per-check and per-target `Run now` actions

Detail panel:

- opens without navigating away from the target list
- shows the active check configuration with secrets redacted
- shows the latest diagnostic details
- shows the latest current or last-known diagnostic details
- includes the persisted status timeline and range selector
- shows session boundaries and `Not monitoring` gaps explicitly
- may show observed availability for the selected range
- provides copy buttons for concise result and diagnostic text

History view:

- lists current and previous sessions with start, end, clean/unclean ending, monitored duration, and summary counts
- selecting a session filters the timeline and result context to that session
- soft-deleted targets and checks remain available in historical views and are clearly marked as deleted
- links to `Data & history` for retention settings, database statistics, purge previews, and maintenance actions
- includes an explicit `Clear history` action with preview and confirmation; clearing history must not delete configuration

Interaction requirements:

- Remain usable at 1024 × 700 and scale cleanly to large desktop displays.
- Support keyboard navigation for primary actions.
- Provide visible focus states and accessible names for icon-only controls.
- Never use color as the only status indicator.
- Include deliberate first-run, empty, loading, configuration-error, and all-passing states.
- Never steal focus or open another window because a status changes.

## 10. Application architecture

Use three clear layers:

1. **Core:** configuration models, check implementations, scheduler, status calculation, and history interval logic.
2. **Electron main/preload:** application lifecycle, SQLite repository, import/export, file selection, controlled child processes, and typed IPC.
3. **Renderer:** React interface and operator interactions only.

Requirements:

- Core check logic must not live in React components.
- The renderer must not receive direct Node, filesystem, shell, or Electron access.
- Expose a narrow typed API through `contextBridge`.
- Validate every IPC argument in the main process.
- Queued commands acknowledge immediately and publish later status changes as events.
- Closing the main window must cancel or abandon active work safely and exit the process.
- Do not start a local HTTP server.

Minimum renderer API:

- `getSnapshot()`
- `runCheck(targetId, checkId)`
- `runTarget(targetId)`
- `runAll()`
- `pauseCheck(targetId, checkId)`
- `resumeCheck(targetId, checkId)`
- `pauseAll()`
- `resumeAll()`
- `listTargets()`
- `saveTarget(target)`
- `saveCheck(targetId, check)`
- `deleteTarget(targetId)`
- `deleteCheck(targetId, checkId)`
- `importConfiguration(options)`
- `exportConfiguration(options)`
- `getSessions(options)`
- `getTimeline(targetId, checkId, range)`
- `getDatabaseStats()`
- `previewHistoryPurge(options)`
- `purgeHistory(options)`
- `optimizeDatabase(options)`
- `onStatusChanged(callback)`
- `onConfigurationChanged(callback)`
- `onMaintenanceChanged(callback)`

## 11. Security and diagnostics

- Use `contextIsolation: true` and `nodeIntegration: false`.
- Define a restrictive Content Security Policy.
- Package all interface assets locally and do not load remote renderer content.
- Do not implement arbitrary commands or user-provided scripts.
- Construct the native ping command only from validated internal arguments; never concatenate raw shell input.
- Validate URLs, ports, intervals, and timeouts before scheduling checks.
- Escape all configuration-derived display content.
- Never log credentials, authorization headers, cookies, full response bodies, or environment-variable values.
- Never include resolved secrets or historical data in a configuration export.
- Write a small rotating diagnostic log under the application's local-data directory.
- Provide `Open logs folder` and `Open data folder` actions under an About or Help menu.

## 12. Packaging

- Produce a Windows portable executable as the primary artifact.
- An installer may also be produced, but the portable build is required.
- Running the packaged application must not require administrator rights or a separately installed runtime.
- Store the SQLite database, preferences, backups, and logs under the normal per-user local application-data directory.
- Configuration exports may be saved wherever the user chooses.
- If `opossum.yaml` exists beside the executable, offer to import it on first launch.
- Application name, executable name, application ID, data-directory name, and product metadata must be defined centrally.

## 13. Repository structure

```text
opossum/
  README.md
  LICENSE
  package.json
  package-lock.json
  tsconfig.json
  vite.config.ts
  electron-builder.yml
  opossum.example.yaml
  src/
    core/
      config.ts
      models.ts
      scheduler.ts
      status.ts
      timeline.ts
      checks/
        base.ts
        ping.ts
        tcp.ts
        http.ts
    main/
      index.ts
      ipc.ts
      preferences.ts
      storage/
        database.ts
        migrations.ts
        repositories.ts
      transfer/
        export.ts
        import.ts
    preload/
      index.ts
      api.ts
    renderer/
      index.html
      src/
        App.tsx
        components/
        features/
        styles/
    shared/
      contracts.ts
      errors.ts
  tests/
    unit/
    integration/
    e2e/
```

## 14. Testing requirements

Automated tests must cover:

- configuration CRUD, validation, and stable historical identity
- valid and invalid YAML import/export
- deterministic export ordering and secret exclusion
- import preview, conflict behavior, and transactional rollback
- duplicate identifiers
- ping, TCP, and HTTP pass/fail behavior
- timeout, refused connection, name-resolution failure, and unexpected exceptions
- expected HTTP status and content matching
- credentials loaded from environment variables and redacted from output
- prevention of overlapping check execution and unbounded manual queues
- concurrency limits
- status aggregation
- SQLite creation, migrations, transactions, WAL mode, and migration backup behavior
- clean and unclean session boundaries and heartbeat recovery
- status-interval creation, extension, transition, and diagnostic-category changes
- last-known restoration without presenting historical status as current
- offline gaps excluded from observed availability
- timeline queries across current, previous, and multiple sessions
- maximum-age purge, cutoff-crossing interval trimming, and disabled-retention settings
- database/WAL size accounting and oldest-closed-session size enforcement
- protection of current session, configuration, and last-known state during automatic purge
- manual purge previews, confirmations, scoped purges, and all-history purge
- incremental vacuum, WAL checkpoint, optimization, and maintenance summaries
- soft deletion preserving historical records
- configuration import preserving the database after failure
- typed IPC validation and preload boundaries
- critical first-run, last-known, checking, failure, timeline, and all-passing UI states
- keyboard access to primary actions
- clean application shutdown during active checks

Tests must use local test servers and mocks and must not depend on public internet access.

## 15. MVP acceptance criteria

The MVP is complete when:

1. A user can launch the packaged portable Windows executable without installing a runtime or using administrator rights.
2. The user can add and edit targets and checks in the UI, and they persist in SQLite.
3. The user can export shareable YAML configuration and import it with validation, preview, and safe conflict handling.
4. Valid ping, TCP, and HTTP checks begin automatically and update live while OPOSSUM is open.
5. Manual run and pause/resume actions work.
6. A broken or hung endpoint cannot block other checks or crash the application.
7. Closing the window ends the session, exits OPOSSUM, and stops all monitoring activity.
8. Reopening OPOSSUM restores configuration, prior sessions, timelines, and last-known states without mislabeling them as current results.
9. The timeline distinguishes pass, fail, unknown/paused, and periods when OPOSSUM was not running.
10. Stable statuses are stored as compressed intervals rather than an endless result row per poll.
11. Configurable maximum age and database-size controls purge only eligible closed history in bounded batches.
12. The user can preview and run scoped or complete history purges and can inspect/optimize database storage.
13. No service, tray process, API server, or always-on component is created.
14. Secrets are not required in exports and are not exposed in the database history, logs, or interface.
15. The interface meets the modern visual requirements and remains usable at 1024 × 700.
16. Tests pass without internet access.
17. The README explains configuration, import/export, history and purge semantics, database maintenance, operation, packaging, and common failures.
18. The repository and packaged application's About screen identify the project as MIT licensed.

## 16. Explicitly out of scope

- Monitoring while OPOSSUM is closed
- Windows service or system-tray operation
- Launch at startup
- Retaining a separate database row for every successful poll indefinitely
- SLA reports or claims that offline gaps represent endpoint availability
- Cloud backup or synchronization of the SQLite database
- Notifications, email, Teams, Slack, SMS, or webhooks
- Remote agents or multiple monitoring locations
- User accounts, roles, SSO, or multi-tenancy
- Network-accessible dashboard or API
- Configuration merge with automatic conflict resolution
- Exporting monitoring history as part of the configuration file
- Service discovery
- SNMP, Modbus, BACnet, EWS, Windows-service, database, or certificate-expiry checks
- Dependencies, maintenance windows, or alert suppression
- Automatic updates

## 17. License

Release OPOSSUM under the MIT License.

Requirements:

- Include the canonical MIT license text in the repository-root `LICENSE` file.
- Use `Copyright (c) 2026 Mike Wennersten` unless the copyright holder is changed before release.
- Set `"license": "MIT"` in `package.json` and use SPDX identifier `MIT` in other applicable package metadata.
- State `MIT License` in the README and show it in the application's About screen.
- Do not add a source-available, noncommercial, workplace-only, or other conflicting restriction.
- Review direct production dependencies for license compatibility before the first distributed build.
- Preserve required third-party copyright/license notices and include a `THIRD_PARTY_NOTICES` file if any selected dependency requires one.

## 18. Implementation order for Codex

1. Create the Electron/TypeScript project, shared models, SQLite layer, migrations, and database tests.
2. Implement target/check configuration CRUD plus YAML import/export, preview, validation, and tests.
3. Implement the common check interface and ping, TCP, and HTTP checks with tests.
4. Implement the scheduler, concurrency controls, sessions, heartbeats, last-known state, compressed status intervals, timeline queries, and retention engine.
5. Implement the secure preload API and validated IPC boundary.
6. Build the modern main interface, configuration forms, first-run experience, filters, groups, and detail panel.
7. Add the history view, timeline, manual run, pause/resume, import/export, data statistics, purge/optimization tools, and clean shutdown.
8. Complete accessibility, database-recovery, retention-safety, error-state, visual-polish, security, and offline test passes.
9. Add MIT licensing metadata, produce the portable Windows build, and finish the README.

Run formatting, type checking, and relevant tests after each slice. Do not add out-of-scope monitoring-platform features without asking.

## 19. Copy/paste kickoff prompt for Codex

> Build the OPOSSUM MVP described in `opossum-mvp-spec.md`. Treat the file as the product specification and keep the product intentionally small. It is an on-demand foreground utility: checks run only while its main window is open, and closing the window ends the monitoring session and exits completely. Configuration and compressed status history persist in SQLite so prior sessions and last-known states are visible after reopening. Implement the work in the listed order using strict TypeScript, tests alongside each feature, a secure Electron main/preload/renderer boundary, and an MIT license. The modern visual direction, safe YAML import/export, session boundaries, offline-gap semantics, lightweight status timeline, configurable retention, purge previews, and database-size controls are acceptance requirements. Do not add services, tray behavior, notifications, an HTTP server, or other monitoring-platform features. Run formatting, type checking, and relevant tests after every implementation slice. When something is ambiguous, choose the smallest solution consistent with the acceptance criteria and document the choice.
