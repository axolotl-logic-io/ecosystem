# Historical local dashboard reports

This is the pre-import report from `~/workspace/tools/pipeline-dash/`. Statements below describe that earlier source and validation, not the ecosystem app. Its captures and temporary logs are historical references, not imported acceptance evidence. See [current validation](../../REPORT.md).

## Current domain-language alignment

The local source now uses **Workflow runs**, **Agent runs**, **Caller**, **Developer**, and slot/run-count capacity terms. Workflow means dependency-based work, not a fixed serial chain. This changes language and interpretation of source labels, not execution scheduling.

- `data.ts`, `ui.ts`, `index.ts` and `messages.ts` use the canonical concepts. Narrow layouts retain the active pane's full name.
- `language.ts` separates display labels from raw source identities. Legacy `merge` displays as Legacy merge rather than claiming the intended flat stages are installed.
- `tools.ts` registers `workflow_runs` and `workflow_run`. Deprecated `pipeline_lanes` and `pipeline_job` retain their prior JSON shapes. `agentRuns` replaces the local configuration key, with a temporary `operators` reader and canonical-key precedence.
- Requests remain editable and cancellable. Retry and resumption are distinct; templates require reconciliation before repeating uncertain writes. No direct control or additional authority was added.
- The glossary, alignment inventory and assessment plan record dependency-based workflows and the open `add-pipeline-dash-to-ecosystem` item. Source has not moved and the extension symlink has not changed.

Validation of this final source: **68 tests passed; 0 failed, skipped or cancelled. Typecheck passed with no diagnostics.** Commands:

```sh
npm test
node /Users/axolotl-logic/.npm/_npx/5abcb55351612887/node_modules/typescript/bin/tsc --noEmit
```

The compiler was already cached; no package download was required. Test output is at `/tmp/workflow-dash-language-tests.log`. Tests cover canonical labels in both themes, active-pane visibility at narrow widths, raw-identity preservation, canonical/deprecated tool contracts, activation gates, bounds, configuration migration and editable-message safeguards. Existing render tests still cover all panes at widths 40, 80, 110, 160 and 220.

No live dashboard, model invocation, workflow launch, hold change, installation, reload or symlink change was performed for this validation. Source lives in the unversioned `~/workspace/tools/pipeline-dash/` directory. The original files were backed up to `/tmp/pipeline-dash-language.9qpBnh/` before editing.

Observation uncertainty, configured-capacity provenance, verified workflow/agent parent linkage and the flat-stage dependency/recovery migration remain unfinished. Passing language tests does not establish these broader contracts. Historical source identifiers and technical startup/package names remain explicit migration boundaries.

## Historical visual redesign report

The remaining sections and their captures describe the earlier visual redesign, not the current language update. Historical captures and result files remain unchanged.

Date: **2026-10-20**. Directory: `/Users/axolotl-logic/workspace/tools/pipeline-dash/` (not a git repository; nothing staged or committed).

## Delivered

- **`ui.ts`**: Catppuccin-chrome-style rounded pills (`` / ``), CRUST-on-color Nerd Font icon segments, semantic theme colors, consistent author/implement/review/merge badges, elapsed-time bars, accented selection markers, muted secondary text, dim history, and right-aligned durations.
- The widget is **at most five lines**, with one row per live job (up to the existing four-job capacity). Its status row contains RUN/red HOLD, capacity/author/review slots, web activity, installed/main comparison and positively observed pending requests. Narrow widgets shorten the version comparison before clipping.
- Fullscreen Jobs / Issues / Operators / Time tabs have rounded panels and a pill key-hint footer. Lists/details are side by side at **≥110 columns**, stacked below that. Status pills wrap in the fullscreen view. Jobs provide relative launch-duration bars; Enter retains complete launch metadata, colored verification summaries and the local stop reason. Time presents percentage bars for launch kinds and job types, side by side when wide, with the existing session-delta estimates below the job-type chart.
- Issue `agent:*` labels are semantic chips: working blue, merged green, stopped red, ask/not-doable peach, split mauve. Operators show state chips and activity ages. Empty/loading states are muted; missing recognized verification summaries are explicitly reported.
- **`data.ts`**: the two requested read-only accuracy fixes below. No unrelated collection was added. `index.ts` only gains presentation of the already-collected job details, duration bars and themed pagers; lifecycle, tools and message delivery remain unchanged. `messages.ts` is unchanged.
- Expanded tests, README **Look** section, and **20 ANSI tmux captures**, each with a plain-text companion under `shots/`.

Colors are computed in render paths, or by callbacks that consult the current theme; invalidation clears dashboard content state. There are no hard-coded ANSI escapes in extension source. The only fixed concrete color is the requested house-style CRUST icon text; all accent/surface/stage/status colors come from the active theme. Both Catppuccin Mocha and the installed built-in light theme are exercised.

## Accuracy fix 1: project-buddy web gate

Previously, capacity looked only for explicit `scope: "pb-web"`, including old launches, so an active full gate could display `idle/unknown`.

Positive observations now include:

1. A PID-verified live project-buddy job whose **current** launch key starts `verify-`.
2. A current `reviewer-*` launch with an unmatched gate/test bash tool call in its bounded local session journal. A matching tool result clears it.
3. Current explicit `pb-web` scope (job/current launch), not an arbitrary old launch's scope.
4. A bounded, asynchronous `ps -axo pid=,command=` observation containing a playwright, next or vitest runner **and** an argument under `~/.pi/agent/issue-pipeline/work/axolotl-logic-io__project-buddy/`. The path boundary excludes similarly named directories. Explicit `issue-N` paths can attribute the issue; otherwise the display says busy without inventing an issue number.

The UI says **`pb-web busy #N`**, or `busy` when not attributable. Absence says **`not observed`**, not idle/free. An intermediate real smoke screen positively showed **`pb-web busy #499`** during its `verify-10` launch. The running pipeline then independently completed that gate and moved onward; the final captures reflect the later state. Fixture tests reproduce the #499 observation deterministically.

This remains activity detection, not an authoritative scope-lock protocol. `ps` arguments do not always expose cwd, so relative-argument web processes can be missed. The current-launch/session observations cover the requested job-driven case without reading credentials, invoking a model, or inspecting/mutating locks.

## Accuracy fix 2: pending operator requests

Inspected live `status.json`, `events.jsonl` and `control/` run-directory structure, plus installed pi-subagents implementation:

- `src/runs/background/subagent-runner.js`: active tool calls are tracked by ID; `currentTool` / `currentToolArgs` are cleared on tool end, and a blocking supervisor contact raises attention.
- `src/shared/utils.js`: the argument preview explicitly includes `reason=need_decision` / `reason=interview_request` when reason is the previewed field.
- `src/intercom/native-supervisor-channel.js`: native supervisor requests have request/reply lifecycle semantics; their authoritative mailbox is separate from the async run's control directories.
- `src/runs/shared/subagent-control.js`: `needs_attention` and persisted control notices also cover idle/long-running tools and are not proof of an unanswered decision.

The dashboard now counts only an unmatched observed decision/interview contact (matching ends remove it), or a current blocking contact whose status preview **explicitly starts with the decision/interview reason**. Terminal runs override stale tail evidence and show none. Progress updates, generic attention, missing evidence and truncated-away calls are not counted. The old **“(3 unknown)”** display is gone; no request pill appears without positive evidence. No answer/reply/control transport was added.

The bounded run files are not an authoritative cross-process mailbox snapshot. If the start has fallen outside the tail, the preview does not include the reason, or a request is owned by an external intercom implementation, the dashboard omits it rather than guessing. This can undercount; it does not present an unknown count as actionable work.

## Automated validation

Final commands:

```sh
npm test
npm_config_cache="$PWD/.npm-cache" npx -y -p typescript tsc --noEmit
# project-local .npm-cache removed afterward
```

**59 tests passed; 0 failed, skipped or cancelled. Typecheck passed with no diagnostics.** Results: `test/test-results.txt` and `test/typecheck.txt`.

Coverage retained: strict opt-in/inert lifecycle, verified PID liveness/fail-closed errors, bounded/corrupt/missing files, credential-path rejection, capacity, session/stage/time estimates, local verification summaries, and editable-message cancellation/steering/template safety.

Coverage added/expanded:

- Every component and all four tabs at **40, 80, 110, 160 and 220 columns**, in **catppuccin-mocha and light**.
- Zero jobs and four jobs, running and held states, very long titles/missions/output, wide Unicode, and invalidation. Every rendered line is checked with `visibleWidth(line) <= width`.
- Green/yellow/red elapsed-bar thresholds, matching/differing versions, shortened widget version pills, no unknown request count, and verification pass/fail colors.
- Live current verify versus dead/non-PB jobs and old scope; current reviewer gate calls and matching results; scoped process-path matching and issue attribution.
- Pending decisions, replies, progress-only contacts, terminal status, current blocking status and unrelated attention.

The added gate session fixture is synthetic and stored only under `test/fixtures/gate/`. Tests do not launch jobs or inspect their fixture PIDs against the live pipeline.

## Visual smoke test

Fresh detached tmux sessions were started in **`/tmp`** with **`pi --no-session`**, using the globally linked extension, at **160×45** and **90×30**. For each size:

1. Typed `/dash`, Enter; visited Jobs → Issues → Operators → Time using Tab.
2. Drilled into one job with Enter; used End to inspect the summary/footer. Also inspected completed project-buddy #499 and scrolled Time to its job-type/session section.
3. Captured each screen with **`tmux capture-pane -e -p`** and as plain text.
4. Escaped to the editor, captured the widget, ran **`/dash off`**, captured opt-out, exited with **Ctrl+C twice**, and removed the smoke session.

No prompt was submitted. **`a`, `g`, and `t` were never pressed.** No instruction menu, editable prompt submission, model call, job launch, hold change, GitHub write or pipeline control action occurred. The editor captures retain **0/272k** usage. An extra `/reload` between visual iterations reloaded the final code, reset activation, and was followed by `/dash`; this is a slash command, not a prompt.

Critical inspection/iterations included: replacing incomplete top borders with continuous rounded borders; keeping elapsed numbers aligned; removing whole-row fills that were interrupted by nested chip resets; shortening the narrow widget version pill; wrapping fullscreen status pills; eliminating an uncovered pager footer row; and changing the wide Time view from excessively long bars to two balanced panels. Final ANSI captures have the expected Mocha mauve/lavender/peach/green/blue colors and house CRUST/surface segments. Panel edges are aligned and the footer remains visible in both dimensions.

A final capture validation using pi-tui `visibleWidth` checked **20 colored ANSI captures / 730 nontrailing lines**: all fit their 160- or 90-column panes, and every ANSI file contains color sequences. No `pipeline-dash-look-*` tmux session or `.npm-cache` remains.

### Capture index

For **each** suffix `160` and `90`, with `.ansi` and `.txt` companions:

- `jobs-*`, `issues-*`, `operators-*`, `time-*`
- `time-scrolled-*`
- `job-detail-*`, `verify-*`, `verify-pb-*`
- `widget-*`, `off-*`

Example: `cat shots/jobs-160.ansi`.

## Safety / remaining limits

- Extension source still imports no filesystem write APIs. Reads remain asynchronous and bounded; process execution is limited to read-only ps/GitHub/gh-thread reads. Signal 0 remains a liveness probe. There are no credential reads, direct pipeline/operator mutations, subagent-control calls, or model calls.
- Activation remains `/dash`, its existing shortcut or `--pipeline-dash`; `/dash off` closes watchers/timers. Both read-only tools and the editable agent-message boundary are retained. Issue threads still use **only gh-thread**, remain UI-local data and are never sent to the agent automatically.
- Installed/main equality is reliable from the cached SHAs. A difference is yellow and explicitly **“differs”**, not falsely asserted to be behind; SHA inequality alone does not prove ancestry.
- Very narrow widgets still clip; 40-column tests guarantee width safety, not simultaneous visibility of every status field. Extremely short terminals are less useful. The fullscreen view wraps status and retains the detailed fallback.
- Historical launch arrays cannot be recovered after job.json replacement; history remains explicit. Time totals describe the existing retained populations and timestamp-delta approximations, not provider latency measurements.
- Verification extraction intentionally remains the existing bounded `ℹ tests/pass/fail/cancelled` summary parser. The final #499 log had no matching summary; its capture accurately says **no recognized verification summary**, rather than manufacturing a pass result. Other test reporters are a remaining coverage limit.
- Positive web-gate and pending-request observations may be incomplete for the reasons above. These are read-only observations, not lock ownership or authoritative supervisor state.
- Live message submission and pipeline actions were intentionally not tested. Existing mocked message-delivery/cancellation tests cover that boundary. No live issue thread was opened during the smoke test.
