# Workflow dashboard

An opt-in, read-only Pi extension. `/dash` shows the buddy runtime's buddy-run and action-run observations, GitHub items and generic subagent runs. It composes editable requests to the caller, not direct control operations. It is not a scheduler.

The [shared glossary](../../GLOSSARY.md) defines the language. A buddy pairs a role with an identity. A buddy run is one activation of the action loops of all the buddy's tasks; it is not one task execution or one model session. Each action that a buddy run admits for one task and work item is an action run. A model session has its own id and names its action run as its parent; session, run and checkpoint identities are not interchangeable.

## Source and activation

This app brings the former `~/workspace/tools/pipeline-dash/` source into ecosystem. The original directory and `~/.pi/agent/extensions/pipeline-dash` symlink are retained for rollback; this source change does not switch them or reload an existing session. Keep one active copy: loading both registers conflicting commands and tools.

Pi 1.2.0, Node 24, `gh` and `gh-thread` are the tested interfaces. Pi supplies the host packages at runtime. They are peer dependencies, with pinned development copies for reproducible tests; this app does not bundle them.

To try a reviewed checkout without discovering the older extension, start a separate TUI from the repository root:

```bash
pi --no-extensions --extension ./apps/workflow-dash/index.ts --workflow-dash
```

This command disables other discovered extensions for that invocation. It is an operator acceptance step, not an automated test. It starts bounded local reads and GitHub reads, but sends no model prompt. Omit `--workflow-dash` to leave collection inactive until `/dash` or Ctrl+Shift+J. `/dash off` closes watchers and timers; `/reload` resets activation. Non-TUI modes remain inactive.

For persistent cutover, first review the exact source and finish its gates. Preserve the old symlink and configuration, then replace the one existing extension entry with a link to this app in the chosen durable checkout. Do not add a second discovered copy. Reload only the sessions that should use it. To roll back, restore that preserved entry and reload those sessions. A source merge alone does not install or activate dash.

## Views

The panes are **Buddy runs**, **Action runs**, **Issues** and **Subagent runs**. Narrow terminals keep the active tab's full name. Tab and Shift+Tab switch panes; Up/Down select; PageUp/PageDown scroll details; Enter opens the whole recorded observation; Escape closes.

### Buddy runs and action runs

These panes read the observations that the buddy runtime writes under the `runs` folder, as described in the [runtime runs reference](../../docs/reference/runtime-runs.md):

- A buddy run is `runs/buddy-runs/ID/run.json`.
- An action run is `runs/SLUG/issue-N/actions/ID/run.json`, where `SLUG` is the repository with `/` replaced by `__`.
- A session's log is `sessions/KEY.jsonl` beside its action run's `run.json`, where `KEY` is the session's recorded `key`.

The dashboard reads action runs for the configured `repos` and for every repository a readable buddy run names in its scope. It keeps its own reader copy of the published schemas in `runtime-run-schema.ts`, because the pipeline module that exports them also reads the pipeline's environment and configuration. A test runs the pipeline in a subprocess and fails if the two copies differ.

Runs link only through the fields they record. A buddy run names its `previous` buddy run and each task loop's current `action`. An action run names its `buddyRun` and `previous` action run, and each session names its `parent` action run. Details show each link with whether its target was observed. The dashboard never links runs by name, time, PID or shared issue, and it never infers an account, identity, parent or authority.

A buddy run's condition is one of these:

- **Process observed**: it records `running` or `waiting`, its lease is unexpired, its process observation is no older than its lease, it was recorded on this host, and its PID runs Node with `buddy.mjs` or `buddy.ts` as the main script, started with the run. This is a matching process, not proof of the run's identity or of its health.
- **Stale**: an expired lease, an old process observation, an absent process, another program at that PID, or a process that started at another time.
- **Unknown**: another host's record, a denied process inspection, or an observation from the future.
- **Stopped** or **Ended**: the run's own recorded state.

An action run's condition is its own recorded state. A stopped or ended action run stays stopped or ended. A running or waiting action run is **Unconfirmed**, because it has no process observation of its own. Its buddy run's condition is shown separately and never makes the action run live.

Details also warn about an unknown outcome, an uncertain checkpoint, a retained issue execution, a reservation recorded as held, an execution instance or session parent that differs from the action run, a missing session log and a loop action that wasn't observed. An unknown outcome needs reconciliation by reading its effects, never repetition.

### Coverage

Each run pane ends with a **Coverage** row. Coverage is partial when any observation is unreadable, the read bounds omit runs or the runs folder can't be listed. Its details list each unreadable file and why.

A file becomes an unreadable problem, never a run, when it's missing, a symlink, larger than 1 MiB, not JSON, of another kind or version, or doesn't match the schema. A run whose recorded id, repository or issue differs from its folder is a problem too. The dashboard reads the newest 200 buddy runs and the newest 500 action runs by folder time.

### Subagent runs

The **Subagent runs** pane reads generic pi-subagents harness records (`status.json`, `events.jsonl` and output logs). A subagent run is not a buddy run: it names no buddy, task, action run or parent, and none is inferred from its launch name, model, mission or path. An account appears only when the record has a validated `account` string or `{provider, login}`; it is unverified metadata, never an authenticated identity. Records default to runs started today. Pending questions come from bounded contact events, not an authoritative mailbox.

### Observation limits

- A hold that wasn't found is only **not observed**.
- `pb-web` activity is a positive observation, not a resource reservation. Its absence means **not observed**, not free.
- GitHub lists stop at 100 open items per repository and kind, exclude ecosystem titles beginning `ops: migrate`, and wait at least two minutes between attempts. Errors appear in issue details. Cached main is not live target evidence.

## Requests and tools

`a` opens selected-item templates; `g` opens global templates; `t` opens a free-text caller editor. Templates ask the caller to investigate a run, to assess a scoped stop, or to reconcile an unknown outcome by reading its effects. They state that a dashboard condition is an observation, not proof.

Every request is editable. Cancelled, blank or invalidated dialogs send nothing. Only submitted text reaches `sendUserMessage`, normally when idle or as a steer when busy, with prompt-template expansion disabled. Requests do not grant authorization. Issue titles, missions, output and thread content never enter templates automatically.

The read-only tools are:

- `buddy_runs {}`: every observed buddy run and action run with its condition and links, the unreadable observations and coverage.
- `action_run {id}`: one action run's whole observation with its buddy run, previous action run and session links, including each session log's path and state.

Tools activate only with collection, declare read-only annotations and cap text output at 12 KB.

Enter on an issue runs only `gh-thread NUMBER -R REPOSITORY`. The filtered text stays UI-local data and is never automatically sent to a model. PR entries are read-only. `r` refreshes local data and requests a cache refresh; `p` opens the plan pager.

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

The dashboard no longer reads the former names `buddyRuns`, `agentRuns` and `operators`; set `subagentRuns` instead. `--workflow-dash` is the only activation flag. The widget key keeps the old technical name `pipeline-dash`.

## Safety

No workflow state, hold, lease, credential, resource or GitHub writes. No run launches, termination, subagent control or model calls. Signal-0 process probes check existence and permission; they do not terminate a process. Subprocesses have bounded timeouts and buffers.

The data layer refuses `.env*` paths and the known credential-store paths, including resolved symlink targets. Directory enumeration does not traverse symlinked entries. GitHub reads use the existing `gh` environment without obtaining or changing authentication.

## Check

From the repository root:

```bash
npm ci --ignore-scripts
npm run typecheck --workspace @ecosystem/workflow-dash
npm test --workspace @ecosystem/workflow-dash
npm run lint --workspace @ecosystem/workflow-dash
```

The equivalent mise tasks are `//apps/workflow-dash:typecheck`, `:test`, `:lint` and `:check`. `check` includes all three gates. The root design and type rules apply, with the same narrow Node process-boundary and Pi default-export exceptions used by the pipeline. The full app gate passes without suppressing inherited lint debt.

Tests go through a real dependency: temporary files, the runtime's configuration file and watchers, or the extension entrypoint with a fake Pi host. They never activate a live extension or call a real model. The [preserved pre-import report](docs/history/local-dash-report.md) is historical, not current acceptance evidence. Its terminal captures remain in the original directory and are not imported. The [import validation report](REPORT.md) records the 2026-10-22 import's checks; it predates the buddy-run and action-run views.
