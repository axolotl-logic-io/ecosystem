# Workflow dashboard

An opt-in, read-only Pi extension. `/dash` observes workflow runs, GitHub items and buddy-run source records. It composes editable requests to the caller, not direct control operations. It is not a scheduler.

The [shared glossary](../../GLOSSARY.md) and [buddy and task decisions](../../docs/decisions/buddies-and-tasks.md) define the language. A buddy pairs a role with an identity. Each buddy run performs one task for one binding. Sessions retain conversation; they are not run identities. Every workflow restart is a new linked retry from kept work, not resumption under the old run identity.

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

The panes are **Workflow runs**, **Issues**, **Buddy runs** and **Time**. Narrow terminals keep the active tab's full name. Tab and Shift+Tab switch panes; Up/Down select; PageUp/PageDown scroll details; Escape closes.

Workflow runs show source invocation IDs, raw launch identities and display-only labels. Enter opens timelines, bounded verification summaries and stop reasons. The Time pane separates launch snapshots, source-stage journal totals and approximate session timestamp deltas. These are different populations, not a single authoritative accounting ledger.

Buddy runs currently read Pi subagent records, not a complete buddy execution registry. Rows and details show an account only if the source explicitly records a validated `account` string or `{provider, login}`. Missing accounts show **unknown**. This metadata is not an authenticated identity. Do not infer Hippy, Lawd, account, task, binding or workflow parent from a launch name, model, mission or session path. Model-free runs are not yet collected.

### Legacy delivery evidence

The installed technical stage `merge` still displays as **Legacy merge**. Its intended task coverage is **Sync, Integration, Security, Land and Completion**. That mapping does not identify the current task, prove a result or establish readiness. Details and canonical tools state that the current task, binding and result are not observed.

Other compatibility labels map `author` to Author, `implement` to Implementation and `review` to Hardening. A source stage is not itself revision-bound task evidence. Display-only `developer-*` labels retain original `implementor-*` keys for file access and addressing.

The label can retire when explicit task evidence is available, the workflow changes are installed, and dash has a tested reader and historical compatibility path. Ecosystem [#180](https://github.com/axolotl-logic-io/ecosystem/issues/180), [#183](https://github.com/axolotl-logic-io/ecosystem/issues/183), [#184](https://github.com/axolotl-logic-io/ecosystem/issues/184), [#185](https://github.com/axolotl-logic-io/ecosystem/issues/185) and [#186](https://github.com/axolotl-logic-io/ecosystem/issues/186) provide the upstream task contracts; [#181](https://github.com/axolotl-logic-io/ecosystem/issues/181) owns their installation and acceptance. No new task-result schema or scheduler is invented here.

### Observation limits

- A matching process observation is not a verified live lease. Denied inspection, missing execution data and invalid PIDs remain **unknown** rather than becoming stopped or complete.
- Current canonical capacity reports observed and unknown process counts. Configured resource caps, leases and releases are not collected; limits stay unknown. No absence observation releases a resource.
- A recorded end or stop is described as a source record, not work-item completion. A hold that was not found is only **not observed**.
- Missing, refused, partial or malformed file reads can still omit items. Lists are not exhaustive. Pending questions are inferred from bounded contact events, not an authoritative mailbox.
- Buddy records default to runs started today. GitHub lists stop at 100 open items per repository/kind, exclude ecosystem titles beginning `ops: migrate`, and have a two-minute minimum between attempts. Errors appear in issue details; cached main is not live target evidence.
- `pb-web` activity is a positive observation, not a resource reservation. Its absence means **not observed**, not free. Source process inspection is bounded but still scans process-command output for this scope.
- Historical run launches cannot be joined reliably after `job.json` replacement. Launch timing uses consecutive starts. Large session logs are tailed, making totals lower bounds. Timing bars retain historical display references, not installed time-budget policy.

## Requests and tools

`a` opens selected-item templates; `g` opens global templates; `t` opens a free-text caller editor. Templates preserve source identifiers, ask for new linked retries from checkpoints, require uncertain-write reconciliation and preserve task/binding budgets. Resource requests keep unknown consumers held.

Every request is editable. Cancelled, blank or invalidated dialogs send nothing. Only submitted text reaches `sendUserMessage`, normally when idle or as a steer when busy, with prompt-template expansion disabled. Requests do not grant authorization. Issue titles, missions, output and thread content never enter templates automatically.

The canonical read-only tools are:

- `workflow_runs {}`: observed and uncertain process entries; capacity coverage; hold observation; installed and cached main SHAs. Each entry carries `sourceStage`, `stageLabel`, `taskCoverage` and `processObservation`.
- `workflow_run {repo, issue}`: the latest retained nonhistorical invocation, launches, recorded outcome, verification summaries, stop reason and the same evidence distinctions.

Tools activate only with collection, declare read-only annotations and cap text output at 12 KB. The canonical capacity contract now uses `observedProcesses`, `unknownProcesses`, `configuredLimit: null` and `source`; callers must not treat the old display limits as configuration.

Deprecated `pipeline_lanes` and `pipeline_job` retain their old JSON contracts, including historical capacity assumptions. They are compatibility output, not authoritative resource evidence. Remove them only after callers migrate and receive a breaking-change notice.

Enter on an issue runs only `gh-thread NUMBER -R REPOSITORY`. The filtered text stays UI-local data and is never automatically sent to a model. PR entries are read-only. `r` refreshes local data and requests a cache refresh; `p` opens the plan pager.

## Configuration

Edit `workflow-dash.json` beside `index.ts`, then reload the intended session. Move values from the old `pipeline-dash.json` deliberately during cutover; this app does not read or rewrite that old file automatically. Paths expand `~/`. Missing or malformed settings fall back to defaults; invalid repository names are rejected.

| Key | Default |
| --- | --- |
| `runs` | `~/.pi/agent/issue-pipeline/runs` |
| `installed` | `~/.pi/agent/issue-pipeline/INSTALLED.json` |
| `hold` | `~/workspace/agent-handoffs/project-buddy/20261019-launch-ready/CUTOVER-HOLD` |
| `plan` | `~/brain/plans/issue-pipeline.md` |
| `buddyRuns` | Current OS temporary directory, then `pi-subagents-uid-UID/async-subagent-runs` |
| `repos` | Ecosystem and Project Buddy in `axolotl-logic-io` |
| `mainRepo` | `axolotl-logic-io/ecosystem` |

`UID` is the current Unix user ID. Override `buddyRuns` if the external runtime uses another layout. No private runtime configuration is read to discover it.

String-valued configuration precedence is `buddyRuns`, then deprecated `agentRuns`, then deprecated `operators`. Only `buddyRuns` appears in normalized configuration. `--workflow-dash` is canonical; `--pipeline-dash` remains a deprecated activation flag. The internal widget key retains its old technical name. These compatibility boundaries need removal notices, not silent deletion.

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

Tests use temporary files, mocked Pi delivery/process probes and local fixture snapshots. They never activate a live extension or call a real model. Theme tests use Pi's built-in dark/light themes rather than a personal theme or a checkout-local package symlink. [Fixture provenance](test/fixtures/README.md) distinguishes copied source bytes from synthetic evidence. The [preserved pre-import report](docs/history/local-dash-report.md) is historical, not current acceptance evidence. Its terminal captures remain in the original directory and are not imported. [Current validation](REPORT.md) records this worktree's checks and blockers.
