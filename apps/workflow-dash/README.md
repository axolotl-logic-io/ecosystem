# Workflow dashboard

An opt-in Pi extension. `/dash` shows task runs across the configured repositories: what runs now, which runs failed or stopped, which issues are open or closed today, and each run's sessions, context growth and token usage. It reads these observations from the shared database. It schedules nothing. Its one write is a retry, which applies a start label again when you ask it to.

The [shared glossary](../../GLOSSARY.md) defines the language. A buddy launches a task app for each `start:X` label it sees. Each task run that wins its claim writes a [task run record](../../docs/reference/runtime-runs.md#task-run) with its task, account, lifecycle step (`mark`, `work` or `unmark`), state and outcome. Its model sessions write their transcripts beside it.

## Run the dashboard

Pi 1.2.0, Node 24 and `gh` are the tested interfaces. Pi supplies the host packages at runtime. They are peer dependencies, with pinned development copies for reproducible tests; this app does not bundle them.

To try a checkout in a separate TUI, run from the repository root:

```bash
pi --no-extensions --extension ./apps/workflow-dash/index.ts --workflow-dash
```

This command disables other discovered extensions for that invocation. It starts bounded, read-only database queries and sends no model prompt. Omit `--workflow-dash` to leave the view inactive until `/dash` or Ctrl+Shift+J. `/dash off` closes the database connection; `/reload` resets activation. Non-TUI modes remain inactive.

To install the dashboard, link this app as one discovered Pi extension and reload the sessions that should use it. Keep one active copy: two copies register conflicting commands and tools.

## Work view

`/dash` opens one view of every configured repository. Every value comes from the shared database's monitoring tables; the view reads no run records and calls no GitHub API. `f` cycles the repository filter.

Each issue appears once, with its newest task run, in one of these groups:

| Group | Meaning |
| --- | --- |
| **ACTIVE** | Its newest task run is running: its process was observed on the collector's host. |
| **NEEDS YOU** | Its newest task run failed or stopped, or is unavailable: recorded as running, but with no process observed. The first line of its reason follows. |
| **OPEN** | The issue is open and has no task run, or its newest task run succeeded. A succeeded task run is not a closed issue. |
| **SUBAGENTS** | Generic subagent sessions that belong to no task run. |
| **FINISHED** | Issues closed today. |

A task run row shows its account, task and state: `implement › work` while it runs, and `implement succeeded` or `implement failed` once it ends. The row also shows elapsed time, the newest session's latest context and the run's total tokens. An active session also shows the age of its last recorded activity. Elapsed time stops when the run ends. Long duration or inactivity alone is not a failure. A dash (`—`) means no measurement, never zero.

An issue's `start:X`, `agent:X:running` and `agents:stop` labels show below it, as GitHub reported them at the last read. They are observations: a start label is a start that no buddy has claimed yet, and `agent:X:running` stays on the issue after a crashed run until a person removes it.

The header shows when the collector last wrote. It says **Status delayed** when that is more than 30 seconds ago, and **partial data** when collection skipped something. `n` lists notices, such as unreadable records, collection bounds and failed GitHub reads.

### Retry a task run

To retry a failed or stopped task run, select it and press Shift+R, then `y`. The dashboard applies `start:X` to the issue with your `gh` account. A buddy claims it on its next poll, and the new task run continues from what earlier runs left on GitHub.

The dashboard requests one retry for each selected task run. It leaves the issue unchanged when it is closed or already has the start label. When GitHub's answer to the label write is lost, the dashboard doesn't write it again; check the issue on GitHub instead.

## Task run details

Enter on an issue lists its task runs and their sessions. Enter on a session opens its transcript.

A task run's sessions are the transcripts in its `sessions/` folder, named by their session key, such as `work-1`. The session header separates two measures:

- **Context** is the session's latest input context: input, cache reads and cache writes from its newest measured turn. It also shows the starting value, the peak, the context window and compaction target from the recorded runtime policy, and the number of compactions. Context can fall after a compaction.
- **Tokens** is cumulative processing over all turns, split into input, output, cache read and cache write. It includes nested model calls and compaction summaries. The view never sums context across sessions.

The transcript follows new events. Moving up pauses it; End resumes. Tab filters to messages, reasoning or tools; Enter expands an event; `[` loads earlier events, 100 at a time. Reasoning appears only when the provider exposed it in the transcript. Transcript text is untrusted data; the view never sends it to a model.

## Collector

A separate collector process writes the monitoring tables. The view only reads them. To start the collector, run from the repository root with the task apps' data root:

```bash
ECOSYSTEM_DATA_ROOT=DATA_ROOT npm run collect --workspace @ecosystem/workflow-dash
```

`DATA_ROOT` is the absolute directory that the task apps' `ECOSYSTEM_DATA_ROOT` names. The collector reads task runs from its `runs/` folder and refuses to start when the variable is unset or relative.

It polls local records every 5 seconds and GitHub issues every 2 minutes. `--once` collects once and exits. `--config PATH` and `--credentials PATH` override the defaults.

The collector imports:

- the newest 500 task runs of the configured repositories, from `runs/SLUG/issue-N/task-runs/ID/run.json`;
- each task run's sessions from `sessions/KEY.jsonl` beside its record, appending only complete new transcript lines;
- generic subagent run statuses and events;
- open and closed issues for each configured repository, with their workflow labels.

A task run recorded as running is running only when its process runs on the collector's host and started with the run. Otherwise it is unavailable, with the reason. A record that is malformed or under the wrong issue's folder is a notice, never a run.

Sessions link to task runs only through the folder their transcript is in, never by name, time or shared issue. Each transcript file has a cursor, so a restart or replay never duplicates messages or tokens. A truncated or replaced file is refused, not reread. Older observations never overwrite newer outcomes. A failed GitHub read keeps the previous issues and records a notice.

Before storage, the collector removes credentials in assignments, authorization headers and connection URLs, and terminal control sequences. It omits tool output that reads credential files and clips very large bodies. Monitoring data has no automatic expiry. To clear it, stop the collector, delete the rows of the three `monitor_*` tables and start it again; it imports the records on disk from the start.

## Read tool

The extension registers one read-only tool for agents when the dashboard activates:

- `task_runs {repo?, issue?}`: the task runs in the monitoring database, newest first, optionally for one repository and issue number. Each has its task, account, step, state, reason, times, sessions and token totals.

It reads the same database snapshot as the view, declares a read-only annotation and caps its output at 12 KB.

## Configuration

Edit `workflow-dash.json` beside `index.ts`, then reload the intended session. The view and the collector read the same file. Paths expand `~/`. Both refuse a file that is missing, isn't JSON or has an unknown key or an invalid value: the view stays inactive and says why, and the collector exits 1.

| Key | Default |
| --- | --- |
| `repos` | `axolotl-logic-io/ecosystem` and `axolotl-logic-io/project-buddy` |
| `subagentRuns` | Current OS temporary directory, then `pi-subagents-uid-UID/async-subagent-runs` |

`repos` lists `OWNER/REPO` names; the view uses only this key. `UID` is the current Unix user ID. Set `subagentRuns` if the external subagent runtime uses another layout. No private runtime configuration is read to discover it.

### Database access

The view and the collector each read a private credential file with one `DATABASE_URL` line:

| Process | Default file | Grants it needs |
| --- | --- | --- |
| View | `~/.config/issue-pipeline/monitoring-reader.env` | `SELECT` on `monitor_entities` and `monitor_events` |
| Collector | `~/.config/issue-pipeline/monitoring-writer.env` | `SELECT`, `INSERT` and `UPDATE` on the three `monitor_*` tables, and their sequence |

Each file must be a regular, owner-only file, not a symlink. Neither process falls back to an inherited `DATABASE_URL` or other credentials. Grant neither role access to other tables. The view also runs each read in a read-only transaction.

## Safety

The view writes nothing to the database. Its only write anywhere is a retry's start label on GitHub, made with your `gh` account after you confirm it. The collector writes only the `monitor_*` tables and never writes to GitHub. Neither launches or stops runs, controls subagents or calls a model. Subprocesses have bounded timeouts and buffers.

The data layer refuses `.env*` paths and the known credential-store paths, including resolved symlink targets. Directory enumeration does not traverse symlinked entries. Transcript files must stay inside their configured runs folder. GitHub reads use the existing `gh` environment without obtaining or changing authentication.

## Check

From the repository root:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check --workspace @ecosystem/workflow-dash
```

`check` runs the typecheck, the component, component integration and system tests, and the lint. The equivalent mise tasks are `//apps/workflow-dash:typecheck`, `:test`, `:lint` and `:check`.

The database tests need the disposable test service from `compose.test.yml`. To run them, start it, set `TEST_DATABASE_URL` to it and run:

```bash
npm run db:test:up
TEST_DATABASE_URL=postgres://ecosystem_test:ecosystem_test@127.0.0.1:55433/ecosystem_test \
  npm run test:database --workspace @ecosystem/workflow-dash
```

Tests go through a real dependency: temporary files, a disposable PostgreSQL database, real processes or the extension entrypoint with a fake Pi host. The system integration tests run the task framework's sample task app against fake GitHub, then the collector as its own process, and read the result through the view and `task_runs`. No test activates a live extension or calls a real model.
