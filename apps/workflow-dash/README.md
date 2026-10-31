# Workflow dashboard

An opt-in, read-only Pi extension. `/dash` shows current work, elapsed time, finished and remaining work, problems, context growth and token usage across Ecosystem and Project Buddy. It reads these values from the shared database. It is not a scheduler and grants no authority.

The [shared glossary](../../GLOSSARY.md) defines the language. A buddy pairs scope and explicit task responsibilities with an identity. A buddy run is one activation of the action loops of all the buddy's tasks; it is not one task execution or one model session. Each action that a buddy run admits for one task and work item is an action run. A model session has its own id and names its action run as its parent; session, run and checkpoint identities are not interchangeable.

## Source and activation

This app brings the former `~/workspace/tools/pipeline-dash/` source into ecosystem. The original directory and `~/.pi/agent/extensions/pipeline-dash` symlink are retained for rollback; this source change does not switch them or reload an existing session. Keep one active copy: loading both registers conflicting commands and tools.

Pi 1.2.0, Node 24, `gh` and `gh-thread` are the tested interfaces. Pi supplies the host packages at runtime. They are peer dependencies, with pinned development copies for reproducible tests; this app does not bundle them.

To try a reviewed checkout without discovering the older extension, start a separate TUI from the repository root:

```bash
pi --no-extensions --extension ./apps/workflow-dash/index.ts --workflow-dash
```

This command disables other discovered extensions for that invocation. It is an operator acceptance step, not an automated test. It starts bounded, read-only database queries, but sends no model prompt. Omit `--workflow-dash` to leave the view inactive until `/dash` or Ctrl+Shift+J. `/dash off` closes the database connection; `/reload` resets activation. Non-TUI modes remain inactive.

For persistent cutover, first review the exact source and finish its gates. Preserve the old symlink and configuration, then replace the one existing extension entry with a link to this app in the chosen durable checkout. Do not add a second discovered copy. Reload only the sessions that should use it. To roll back, restore that preserved entry and reload those sessions. A source merge alone does not install or activate dash.

## Work view

`/dash` opens one combined view of Ecosystem and Project Buddy work. Every value comes from the shared database's monitoring tables; the view reads no runtime files and calls no GitHub API. `f` cycles the repository filter.

Work appears in these groups:

| Group | Meaning |
| --- | --- |
| **ACTIVE** | A task action is running or waiting, with its current step. |
| **NEEDS YOU** | A task action failed or is blocked, with the first line of its reason. |
| **PENDING** | Open issues with no running action. A finished task is not a landed issue, and a start label alone is not an authorized queued task. |
| **SUBAGENTS** | Generic subagent sessions that name no pipeline action. |
| **FINISHED** | Issues that closed or landed today. |

Each row shows the buddy, the task step, elapsed time, the session's latest context and the action's total tokens. An active session also shows the age of its last recorded activity. Elapsed time stops when the action ends. Long duration or inactivity alone is not a failure. A dash (`—`) means no measurement, never zero.

The header shows when the collector last wrote. It says **Status delayed** when that is more than 30 seconds ago, and **partial data** when collection skipped something. `n` lists notices, such as unreadable records, collection bounds and buddy loops that are held or waiting.

## Task and session details

Enter on a work row lists its task attempts and their sessions. Enter on a session opens its transcript.

The session header separates two measures:

- **Context** is the session's latest input context: input, cache reads and cache writes from its newest measured turn. It also shows the starting value, the peak, the context window and compaction target from the recorded runtime policy, and the number of compactions. Context can fall after a compaction.
- **Tokens** is cumulative processing over all turns, split into input, output, cache read and cache write. It includes nested model calls and compaction summaries. The view never sums context across sessions.

The transcript follows new events. Moving up pauses it; End resumes. Tab filters to messages, reasoning or tools; Enter expands an event; `[` loads earlier events, 100 at a time. Reasoning appears only when the provider exposed it in the record. Transcript text is untrusted data; the view never sends it to a model.

## Collector

A separate collector process writes the monitoring tables. The view only reads them. Start the collector from the repository root:

```bash
npm run collect --workspace @ecosystem/workflow-dash
```

It polls local records every 5 seconds and GitHub issues every 2 minutes. `--once` collects once and exits. `--config PATH` and `--credentials PATH` override the defaults.

The collector imports:

- buddy runs, action runs and their sessions from the runtime records described in the [runtime runs reference](../../docs/reference/runtime-runs.md);
- task app runs, shown as actions, from the task run records described in the [runtime runs reference](../../docs/reference/runtime-runs.md#task-run);
- each session's transcript, appending only complete new lines;
- generic subagent run statuses and events;
- open and closed issues for each configured repository.

Sessions link to actions only through recorded parent identifiers, never by name, time or shared issue. Each transcript file has a cursor, so a restart or replay never duplicates messages or tokens. A truncated or replaced file is refused, not reread. Older observations never overwrite newer outcomes. A failed GitHub read keeps the previous issues and records a notice.

Before storage, the collector removes credentials in assignments, authorization headers and connection URLs, and terminal control sequences. It withholds tool output that reads credential files and clips very large bodies. Monitoring data has no automatic expiry. To clear it, delete rows from the `monitor_*` tables only; never empty the coordination tables while buddies run.

## Read tools

The extension keeps two read-only tools for agents. They read the runtime records directly, on demand, and do not use the database:

- `buddy_runs {}`: every readable buddy run and action run, with links, unreadable files and coverage.
- `action_run {id}`: one action run's whole record with its buddy run, previous action run and session links.

Tools register when the dashboard activates, declare read-only annotations and cap output at 12 KB.

## Configuration

Edit `workflow-dash.json` beside `index.ts`, then reload the intended session. Move values from the old `pipeline-dash.json` deliberately during cutover; this app does not read or rewrite that old file automatically. Paths expand `~/`. Missing or malformed settings fall back to defaults; invalid repository names are rejected.

| Key | Default |
| --- | --- |
| `runs` | `~/.pi/agent/issue-pipeline/runs` |
| `installed` | `~/.pi/agent/issue-pipeline/INSTALLED.json` |
| `hold` | `~/workspace/agent-handoffs/project-buddy/20261019-launch-ready/CUTOVER-HOLD` |
| `plan` | `~/brain/plans/issue-pipeline.md` |
| `subagentRuns` | Current OS temporary directory, then `pi-subagents-uid-UID/async-subagent-runs` |
| `repos` | Ecosystem and Project Buddy in `axolotl-logic-io` |
| `mainRepo` | `axolotl-logic-io/ecosystem` |

`UID` is the current Unix user ID. Override `subagentRuns` if the external runtime uses another layout. No private runtime configuration is read to discover it.

The dashboard no longer reads the former names `buddyRuns`, `agentRuns` and `operators`; set `subagentRuns` instead. `--workflow-dash` is the only activation flag. The collector uses the same configuration file; the view uses only `repos`.

### Database access

The view and the collector each read a private credential file holding one `DATABASE_URL` line:

| Process | Default file | Grants it needs |
| --- | --- | --- |
| View | `~/.config/issue-pipeline/monitoring-reader.env` | `SELECT` on `monitor_entities` and `monitor_events` |
| Collector | `~/.config/issue-pipeline/monitoring-writer.env` | `SELECT`, `INSERT` and `UPDATE` on the three `monitor_*` tables, and their sequence |

Each file must be a regular, owner-only file, not a symlink. Neither process falls back to `DATABASE_URL` or to the pipeline's coordination credentials. Give neither role access to the coordination tables. The view also runs each read in a read-only transaction.

## Safety

The view makes no writes. The collector writes only the `monitor_*` tables; it never touches coordination claims, holds, leases, resources or GitHub. Neither launches or stops runs, controls subagents or calls a model. Subprocesses have bounded timeouts and buffers.

The data layer refuses `.env*` paths and the known credential-store paths, including resolved symlink targets. Directory enumeration does not traverse symlinked entries. Transcript files must stay inside their configured runs folder. GitHub reads use the existing `gh` environment without obtaining or changing authentication.

## Check

From the repository root:

```bash
npm ci --ignore-scripts
npm run typecheck --workspace @ecosystem/workflow-dash
npm test --workspace @ecosystem/workflow-dash
npm run lint --workspace @ecosystem/workflow-dash
```

The database tests need the disposable test service from `compose.test.yml`. Set `TEST_DATABASE_URL` to it, then run:

```bash
npm run test:database --workspace @ecosystem/workflow-dash
```

The equivalent mise tasks are `//apps/workflow-dash:typecheck`, `:test`, `:lint` and `:check`. `check` includes all three gates. The root design and type rules apply, with the same narrow Node process-boundary and Pi default-export exceptions used by the pipeline. The full app gate passes without suppressing inherited lint debt.

Tests go through a real dependency: temporary files, a disposable PostgreSQL database, the runtime's configuration file and watchers, or the extension entrypoint with a fake Pi host. They never activate a live extension or call a real model.
