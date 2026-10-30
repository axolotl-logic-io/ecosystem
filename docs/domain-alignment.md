# Domain alignment inventory

This draft maps inspected differences to the accepted [shared glossary](../GLOSSARY.md). It is an implementation-planning artifact, not a migration tool or claim of completed alignment. The initial inventory changed no implementation. Autumn subsequently authorized dash source-language alignment; its progress is recorded below. No installation, activation, saved authority or pipeline execution policy changed as part of this work.

Tasks replace Stage, and a role is a set of tasks. Buddies, accounts and identities name who acts, and merge means only a Git merge. [Tasks, buddies and landing](#tasks-buddies-and-landing) maps that model onto the installed release, `42a8771`. Older sections keep their original evidence and say where the current model supersedes them.

Five delivery tasks and a review loop on the pull request (PR) replace the separate-duties tasks. [PR review tasks](#pr-review-tasks) maps them onto the source.

Label-started task apps then replace the task actors, their signals and their records. Each task becomes a command-line program that only its start label starts, and GitHub becomes the only record of earlier work. [Label-started task apps](#label-started-task-apps) records that migration, and it supersedes the older sections wherever they disagree.

## Scope and evidence

The inventory covers ecosystem's issue pipeline, the local Pi dash extension, the status-report skill, and the issue-pipeline and test-assessment plans. It records known change surfaces, not a complete symbol-by-symbol audit.

| Source | Inspected location | Evidence boundary |
| --- | --- | --- |
| Ecosystem | `apps/issue-pipeline/`, root practices and `docs/` | Checkout at `3b163fbee47e27ed431bc832f5ee2ebfad5f9db1`; this is not a live-installation observation. The tasks-and-buddies section rechecked `42a8771774c7ab95c0f151debc4bf55cf2fe9098`, the release installed on 2026-10-22. |
| Dash | `~/workspace/tools/pipeline-dash/`, including `data.ts`, `index.ts`, `ui.ts`, `messages.ts`, `language.ts`, `tools.ts` and tests | The installed extension path links to this unversioned directory. No copy was found in ecosystem. Validation uses fixtures, not an active dashboard. |
| Status-report | `~/brain/skills/status-report/SKILL.md`, `references/sources.md`, `assets/report-template.md` | Instruction and template inspection only, not a collected live status report. |
| Issue-pipeline plan | `~/brain/plans/issue-pipeline.md` | Read in full. Accepted intent and historical records are not proof of installed behavior. The plan is maintained by another session; it was not edited. |
| Assessment plan | `~/brain/plans/stryker-test-assessment.md` | Accepted product and domain decisions. The assessment app has not been implemented. |

Read the owning repository's current instructions and recheck source versions before implementing. The issue-pipeline plan's operational delegation belongs to that work; it does not authorize this migration's installs, launches or cleanup.

## Current alignment

Autumn accepted **Workflow run** instead of Pipeline run and a dependency-based **Workflow**, not an inherently serial chain. Work can branch, run concurrently, join results and repeat checks where its dependency and authorization rules permit. Stage identities remain flat; the complete execution graph remains to be designed. Exact-candidate Security before an authorized Merge remains required. The current model restates this as flat tasks, with a Security result for the exact revision before Land.

Autumn also accepted specific prerequisites: actions wait for the particular results, conditions and permissions they need, not unrelated work with the same stage label. Bind evidence to the relevant change/version and authorization scope. A passing Security check for change A does not authorize Merge, does not satisfy a check for a changed version of A, and need not wait for unrelated security work on change B. The concrete dependency representation remains open.

Local dash source now uses Workflow runs and Agent runs panes (Agent runs is to become Buddy runs, showing each run's account), Caller request wording, Developer display labels, and slot/run-count capacity wording. Backing types and collectors use the same concepts. The read-only canonical tools are `workflow_runs` and `workflow_run`; deprecated `pipeline_lanes` and `pipeline_job` retain their earlier JSON contracts for existing callers. Configuration uses `agentRuns`, with a temporary `operators` reader and canonical-key precedence. Remove these compatibility readers only after caller/config migration and a removal notice.

Display labels do not rewrite upstream evidence. Run IDs, launch keys, session paths and raw stages remain intact. Legacy `implement`/`review` display as Implementation/Hardening; the umbrella `merge` displays as Legacy merge, not as proof of the intended flat stages. The two run views are not joined by verified parent–child links. No new scheduler or parallel-execution mechanism was implemented.

Final dash-source checks passed: 68 tests, with no failures/skips/cancellations, and TypeScript `--noEmit` with no diagnostics. Tests use fixtures and mocked delivery, not live model or workflow executions. The local `REPORT.md` records commands and limits; older terminal captures remain historical evidence.

The local source path, package identity, extension symlink and `--pipeline-dash` flag retain historical technical names pending an explicit source/install migration. Language alignment does not complete uncertainty reporting, capacity provenance or stage/identity-contract changes. The tables below retain original inspected names where useful as migration references.

### Open source-relocation item

`add-pipeline-dash-to-ecosystem` in `~/brain/plans/stryker-test-assessment.md` records Autumn's request to add dash's source, tests, configuration and documentation to ecosystem. It is open and unassigned. Before implementation, choose the destination, tooling/workspace integration, technical-name migration and installation/update contract. Preserve existing callers/configuration and distinguish source delivery from an operator-authorized extension cutover. No copy, move or symlink change has been performed.

## Label-started task apps

These mappings move the source from the five task actors onto the model in the [domain runtime contract](domain-runtime-contract.md). Issues #246 and #248 to #254 make the code changes; this page and the glossary changed first, in #247. Nothing here is installed yet. Until each code issue lands, the reference pages describe the code as it is.

### Names

| Old name | New name | Class | Issue |
| --- | --- | --- | --- |
| Author task, `author`, `start:author` | Gherkin task, `gherkin`, `start:gherkin` | Terminology; public label impact | #249 |
| `prompts/author.md`, `agents/issue-pipeline-author.md`, `models.author` | `prompts/gherkin.md`, `agents/issue-pipeline-gherkin.md`, `models.gherkin` | Terminology; config impact | #249 |
| None | Task app: a task's command-line program, built on the task framework | New term | #246 |
| Accepted start signal, spent start | Claim: a buddy's removal of `start:X`, confirmed on the timeline as made by its own account | Structure | #246 |
| None | Running label: `agent:X:running`, which shows a live run and never gates a start | New public label | #246 |
| Sensor, inbox, signal matching | None: a task app reads GitHub directly | Structure | #246, #254 |
| Qualified signal | Start label, trusted through GitHub's triage permission | Behavior | #246 |
| Receipt, task result record | Result: a GitHub artifact | Structure; persisted impact | #250 to #254 |
| Checkpoint | None: every run continues from GitHub | Structure; persisted impact | #246, #254 |
| Durable stop latch | Stop: `agents:stop` holds only while it's on the issue | Behavior | #246 |
| Landing account, development account | The buddy's own GitHub account | Structure; config impact | #248 |

Renaming the `start:author` label in place on GitHub keeps it on issues that already carry it. Issue #207 carries it today, so Gherkin would start on #207 once the new release is installed.

#249 made the Gherkin rename in the source. The operator renames the GitHub label, the repository config's `models.author` and any buddy file's `identity.models.author` and `author` responsibility when installing it. The buddy runtime skips the retired Author task's records rather than holding the issue: an accepted signal record of `start:author`, and a task ledger record bound to `author`. An Author comment has no task app marker, so Gherkin's first run on an issue posts a new Gherkin comment rather than editing the Author's.

### Behavior

| Old behavior | New behavior | Issue |
| --- | --- | --- |
| A task declares sensors, receives signals in an inbox and matches them to actions | The framework runs claim, mark, work and unmark; a task supplies only its work | #246 |
| A start qualifies only when a current organization member applied it | A start label being present is enough, because only triage access or higher can add labels | #246 |
| A refused Verify, a person's request for changes or Land's conflict makes Fix ready | Only `start:fix` starts Fix | #252 |
| A passed Verify and an approval make Land ready | Only `start:land` starts Land; it reads its prerequisites from GitHub when it runs | #253 |
| Implement waits for an assigned person or a spent start | A start label always starts Implement | #250 |
| A reapplied start retries only a failed run, and a passed or refused run stands | Every start label starts a run, and the run does only what's missing on GitHub | #246 |
| Any accepted `agents:stop` latches the issue and makes pending starts inert | `agents:stop` holds claims and ends live runs while it's there; removing it lets waiting starts run | #246 |
| Fix counts Verify rounds from result causes | Fix counts them from the PR's reviews by Verify's account | #252 |
| Several identities share a GitHub account | Each buddy has its own GitHub account, so an event's `actor` identifies the buddy | #248 |
| The buddy runtime activates task loops, admits actions and reserves capacity | The buddy launches a task app for every start it sees, with no prerequisite check | #248 |

### Records

These records stop being read when the task that wrote them moves to a task app. #254 removes the code that reads and writes them.

| Old record | Replacement on GitHub |
| --- | --- |
| Signal records, accepted starts and stops | The start label and its `labeled` and `unlabeled` timeline events |
| Task-result v2 records, receipts and attempts | The Gherkin comment, the pushed head, the review on a head commit, the merge commit and the closed issue |
| Verify's binding in a result record | The commit that Verify's review was submitted on |
| Saved work state v4, checkpoints and journals | The branch `agent/issue-N`, the PR, its reviews and threads, and each task's own comments, found by hidden marker |
| Action-run observation files | One run record per task run that wins its claim, kept for the workflow dashboard |

Existing records stay where they are as history. No task app reads them, and none is rewritten or relabeled. Work in progress carries over, because the existing branch name is already `agent/issue-N` and the PR, reviews and comments are already on GitHub.

The status labels `agent:working`, `agent:merged`, `agent:needs-info` and the old `agent:stopped-*` labels stop being written. #254 deletes them from the repository once no installed release writes them.

## Tasks, buddies and landing

These mappings apply the buddy and task model to the installed release `42a8771`. They are migration items, not completed changes. Saved state, labels, CLI flags and configuration keys are public or persisted, so each rename needs a compatibility decision before it changes.

### Stages and tasks

| Installed surface | Canonical target | Class | Notes |
| --- | --- | --- | --- |
| `author` stage | Gherkin task, formerly Author | Structure | Optional Author is installed in `42a8771`. |
| `implement` stage | Implementation task | Structure | Performed by the Developer. |
| `review` stage, `hardening` session phase | Hardening task | Structure | |
| `merge` stage | Security, Land and Completion tasks | Structure; public/persisted impact | Dash shows it as Legacy merge. Since #186 Sync and Integration are task jobs of their own (`job.mjs --task`); the merge stage requests them and keeps Security, Land and Completion (`src/roles/merge/`). |
| Session phases `sync`, `security-review` | Sync's resolver (by the Developer) and Security (by the Gatekeeper) | Structure | The writable `integration` phase retired with #186; Integration runs no session. |
| `--stage`, saved `stage`, `stoppedStage`, resume stage | The tasks that may proceed, derived from current results | Structure; public/persisted impact | A saved stage is a cached position that can go stale, as in a `branch-changed` stop. |
| Stage caps (`maxStageJobs`) | Capacity per resource | Structure; operator config | Today's caps act as role caps. |
| `maxAttempts` per stage and run folder | Attempts per task and binding | Behavior | A moved target uses up the landing budget today. |
| "Task" in `src/roles/task-facts.ts` and `change-task.ts` | Brief (proposed): the facts and instruction for one model session | Terminology | Frees task for the workflow unit. |

### Merge, land and sync

| Installed surface | Canonical target | Class | Notes |
| --- | --- | --- | --- |
| Merge as the target-changing step, `src/roles/merge/merge.ts` | Land | Terminology and structure | Landing may fast-forward: PR #155 landed as a fast-forward, with no merge commit. |
| `mergeAttempt`, `codeMerged`, `merge-refused`, `agent:merged` | Landing attempt, landed, landing refused, a landed label | Terminology; public/persisted impact | Labels and signed state need old readers. |
| Merge queue, `--merge-queue` | Landing order | Terminology; CLI impact | An order, not permission. |
| `mergeAccount`, "merge account" | Landing account | Terminology; config impact | |
| `maxSyncs` | A Sync limit | Terminology; config impact | Since #186 it counts Sync runs of one issue without landing. |
| The Sync task job, `src/roles/sync/sync.ts` | The Sync task, separate from Integration and performed by the Developer | Done in #186 | The merge stage no longer synchronizes. |
| Merge commits and `git merge` | Unchanged | None | These are Git merges. |

### Roles, buddies and accounts

| Installed surface | Canonical target | Class | Notes |
| --- | --- | --- | --- |
| Job roles `reader`, `writer`, `merger`, `STAGE_ROLES`, `jobRoles` | Access profiles within an identity: reader, writer and lander | Terminology and structure; config impact | They are credential and access classes, not roles. Each task names the least-privileged profile it needs. |
| `devAccount`, `mergeAccount`, `models.*`, `runtime`, `jobRoles` tokens and network | Accounts and identities | Structure; config impact | `devAccount` is in Hippy's identity and `mergeAccount` in Lawd's. |
| Developer and Reviewer sharing `axolotl-logic-hippy` | Separate buddies, each with its own GitHub account | Structure | The task app model no longer allows a shared GitHub account (#248). |
| Reviewer running both Hardening and Security | Hardening by Hippy, the Developer, in a fresh session; Security by Lawd, the Gatekeeper | Structure and behavior | Moves the installed `review` stage to the development account. No third account is needed. Since #179 the source supports it behind the job flag `--hardening-buddy hippy`; nothing passes the flag until #186. |
| Dash Agent runs pane, `agentRuns` config | Buddy runs, with each run's account shown | Terminology; config impact | Model-free runs, such as landing, belong in the same view. |
| GitHub event `actor` in the retired `src/discovery/` reader | Account, as external data | None | The reader had no importer after E7 and #166 deleted it. Under the task app model, each buddy has its own account, so the `actor` identifies the buddy. |
| Candidate, exact candidate, version | Revision | Terminology | The `REVISION` schema in `src/merge-provenance.ts` and `ReviewedTarget` in `src/reviewed-target.ts` broadly match revision and target state. `REVISION` still accepts historical receipts with no policy and a null code commit. |

### Code names (#165) and persisted names (#166)

Ecosystem #165 renamed the pipeline's code names in source, tests, prompts and docs. #166 then renamed the names saved, configured or sent on the wire, with the compatibility rule in the [operations reference](reference/operations.md): read old and new, write new, never rewrite history. The names that remain are listed with their reason.

| Kind | Renamed | Kept, and why |
| --- | --- | --- |
| Merge meaning land | Code (#165): `reconcileLand`, `landAuthorization`, `landBranch`, `src/ops/land-guard.ts`, `landing-order.ts`, `land-recovery.ts`, `landed-review.ts`, `confirm-landed.ts`, `src/land-provenance.ts`, `src/roles/merge/land.ts`; comments, test titles, prompts and docs. Persisted and wire (#166): saved state v3 `landed`, `codeLanded`, `landingAttempt`, `landingReturn`; `landingAccount`, `landingConfirmation`, `jobRoles.lander`; `--landing-order`; the ops `land`, `confirm-landed`, `reconcile-land` (`src/ops/land.ts`, `landing-attempt.ts`) and their `landed`/`codeLanded`/`landingOrder` keys; the `agent:landed` label; the `lander` role; `ISSUE_PIPELINE_LANDING_GITHUB_TOKEN`; the `landing` account selector. | **Stage:** the `merge` stage, its folder `src/roles/merge/` and `mergeRole`. **Git or GitHub:** merge commits, merge bases, unmerged files, GitHub's `MERGED` and merge API (`pr-merge.ts`, `mergedPr`). **Not landing:** `mergedRole` combines role settings. **Old names kept readable:** v2 state keys, `mergeAccount` and the other old config keys, `--merge-queue`, the old op names, `agent:merged`, the `merger` role. |
| Implementor | `src/roles/implementation/`, `implementationRole`; prose says Developer or Implementation (#165). `models.developer`, the `developer` model and usage role, `developer-` session keys, the `issue-pipeline-developer` agent definition (#166). | `models.implementor` and the `implementor` role stay readable. |
| Orchestrator | Prose that means the caller says caller. | The retained legacy scheduler: `src/orchestrator/`, `orchestrate.ts`, `orchestrate.mjs`, `orchestratorIntervalSeconds`, `mergeWindow`. It is not the caller. |
| Stage | Prose that means a task says task. | Stage as the installed technical name: `Stage`, `STAGES`, stage jobs, `--stage`, the saved `stage`, `stoppedStage`, `resumeStage`, stage caps. Replacing them is the *Structure* change above ("the tasks that may proceed"), not a rename. |
| Coordination | The request record's `identity` is `binding` in record version 2 (#166). | Version 1 records stay readable. |

### PR review tasks

These mappings cover the five delivery tasks and the review loop in the source. The source builds all five tasks and the new signals. Nothing here is installed.

| Removed task | Canonical target | Source state |
| --- | --- | --- |
| `harden` | Implement's fresh hardening session, phase `hardening` | Built; `developer-hardening.md` holds the old `hardening.md` page |
| `sync` | Fix's merge of the base into the PR head | Built; `fix.md` replaces Sync's page, and the sync rebase helpers are removed |
| `integrate` | Verify's full checks and required CI on the PR head | Built in `src/ops/verify-checks.ts` and `src/ops/verify-ci.ts` |
| `review-security` | Verify's review session, phase `security-review`, Security included | Built; `verify.md` is one Verify review page |
| `complete` | Land's close of the issue, in the same result as its merge | Built in `src/ops/land-task.ts` |

| Surface | Change | Class |
| --- | --- | --- |
| `start:implement` only | `start:author`, `start:implement` and `start:verify`, all on the issue | Behavior; public label impact |
| Human signals from labels only | A qualified person's PR review is a `review` signal bound to its head | Structure |
| Review Security refusal fence in `write-authority.ts` | Removed; only an unsettled or passed Land fences code writes | Behavior |
| Per-binding attempt ceiling for repeated review | At most `VERIFY_FIX_ROUNDS` (3) Verify-triggered Fix rounds per issue | Behavior |
| Fast-forward Land with a strict-descendant lease | `gh pr merge --merge --match-head-commit`, then the issue close | Structure; the [merge glossary entry](../GLOSSARY.md#merge) now covers Land's merge commit |
| Task result without a cause | `TaskResult.cause` repeats the attempt's cause | Structure |

In this source, `start:implement` doesn't retry a failed Implement for the same requirements, and Implement doesn't wait for Author. [Label-started task apps](#label-started-task-apps) supersedes the start and review-signal rows above: every task starts only from its own start label, and a review is never a signal.

## Signals and label controls

The glossary defines [Signal](../GLOSSARY.md#signal) and [Stop](../GLOSSARY.md#stop). These are intended contracts; this documentation change implements no execution behavior.

The inspected source still uses assignment-based permission in `src/assignment/grant.ts` and `src/job/assignment.ts`, with fresh checks in `src/execution.ts`. The sweep in `scripts/sweep/plan.ts` filters issues by buddy account assignments. Under the task app model, a buddy's configured scope and tasks decide which starts it runs, and GitHub's label permissions decide who can start a task. GitHub issue assignments are not required.

An earlier version of this inventory described tasks as actors with sensors, an inbox and signal matching, and qualified each start by its producer's organization membership. [Label-started task apps](#label-started-task-apps) replaces that design. A start label on the issue is the only start signal, a buddy's [claim](../GLOSSARY.md#claim) takes it, and `agents:stop` holds claims only while it's on the issue. Existing one-job and model-launch records need explicit mapping; do not relabel them as buddy runs by assumption.

Task names use verbs or name the method they follow. Implement and Gherkin are settled; compatibility for persisted task identifiers still needs decisions.

## Change classes

- **Terminology:** replace different names for the same concept without intentionally changing behavior.
- **Structure:** change domain boundaries, workflow stages, identities or contracts. Requires explicit compatibility and recovery design.
- **Behavior:** correct an observable claim or action, such as reporting Unknown instead of not live after denied inspection.

A terminology change can still affect a public interface or saved record. Classification does not exempt it from compatibility review.

## Buddy and responsibility names

| Existing surface | Canonical target | Class | Required work |
| --- | --- | --- | --- |
| Historical dash Operators pane, collector/config/snapshot fields, templates and docs | Buddy runs (formerly Agent runs and Actor runs) | Terminology; public config impact | The local rename to Agent runs is complete, including `loadAgentRuns()` and `agentRuns` fields; the rename to Buddy runs, with the account shown, is pending. Temporary `operators` configuration compatibility remains. Do not rename third-party runtime paths by assumption. |
| Historical dash orchestrator in README and editor title | Caller | Terminology | Local source wording is aligned. Preserve editable requests, cancellation and no-direct-control behavior. |
| Pipeline `implementor`, `issue-pipeline-implementor`, `models.implementor`, legacy model-role mappings | Developer | Terminology; public/installed/persisted impact | Inventory config keys, agent definitions, role registration, prompts, telemetry, attribution and records. Specify old-reader and old-writer handling before changing wire names. |
| Plan owner/task owner and status-report Assigned to | Assignee where the meaning is work assignment | Terminology; mapping | Preserve explicit plan assignment versus GitHub assignment as separate source observations when they conflict. Do not rename resource owners or policy authority to assignee. |
| Pipeline caller versus legacy `src/orchestrator/` scheduler | Caller only where semantics match | Structure review | The retained autonomous scheduler is not automatically the caller. Inspect and classify each use; do not mechanically replace all orchestrator symbols. |

Evidence includes `apps/issue-pipeline/src/config-schema.ts`, `src/config-legacy.ts`, `src/job/roles.ts`, `src/job/role-context.ts`, dash's `messages.ts`, and the status-report reconciliation rules.

## Work and execution identity

| Existing surface | Canonical target | Class | Required work |
| --- | --- | --- | --- |
| Plan tasks, GitHub issues/PRs and standalone live work | Work items with explicit representation links | Structure | Specify stable identity and explicit joins. Do not join similar titles, bare issue numbers or guessed branches. Do not count an attached PR/run as a separate work item without a distinct outcome. |
| Issue-pipeline job invocation, `--job-id`, latest `job.json`, `jobs.jsonl` | Workflow runs and run records | Structure; public/persisted impact | Dash now exposes source invocation IDs as workflow-run IDs without rewriting them. Upstream identifier/attempt-history migration remains open. Latest-record paths are not complete run history. Preserve old evidence rather than rewriting it in place. |
| Pipeline launch records with `kind: session` or `ops` | Buddy runs or other execution records, with explicit parent linkage | Structure | Inspect which launches are actual runs and which are operation records. Distinguish run identity from local launch key and session-file path. Do not invent historical child IDs. |
| Pi/subagent run IDs and conversation/session IDs | Separate run and session identities | Structure | Verify external runtime semantics. A retained conversation can serve multiple runs; an existing resume command does not prove canonical run resumption. |
| Relaunch/resume/re-attempt dashboard templates and caller restarts | Retry | Terminology and behavior review | Every workflow restart is a retry, a new linked run. Inspect runtime semantics only for externally managed execution. Make request templates accurate without silently adding retry authority. |

Primary source entry points are `src/job/args.ts`, `src/job/launch-record.ts`, `src/job/status.ts`, `src/job/role-context.ts`, dash's `loadWorkflowRuns()` and `loadAgentRuns()`, and the status-report source guide. Inspect their consumers and tests before settling replacement schemas.

## Flat issue-delivery workflow

The inspected checkout declares four stages in `src/stages.ts`: `author`, `implement`, `review`, `merge`. `src/job/roles.ts` and `src/job/role-context.ts` assign Hardening, Integration and Security through session phases. This differs from the accepted flat model. Since 2026-10-22 the accepted units are tasks, not stages, and the target-changing task is Land; the table keeps its original wording.

| Existing concept | Accepted stage | Migration requirement |
| --- | --- | --- |
| Author | Gherkin, formerly Author, optional | Preserve authored and direct requirements modes. Optional Author is installed in `42a8771`. |
| Implement | Implementation | Align stage naming separately from the Developer role. |
| Review / Hardening phase | Hardening | Preserve code/design/test responsibilities and applicable verification. |
| Merge / Integration phase | Sync and Integration | Done in #186: the Developer's Sync writes, and the Gatekeeper's Integration only checks. |
| Merge / Security phase | Security | Assess the exact candidate before target mutation under the accepted plan's policy/target binding. Preserve historical result-phase evidence and recovery. |
| Merge's target mutation | Land (formerly Merge) | Keep only the guarded target-changing operation here. Do not let the new name grant a writer or repeat an uncertain operation. |
| Finish/close and exact-result processing | Completion | Separate delivered-result verification and work-item completion from merge success. Preserve closed-but-incomplete recovery. |

The stage table is an inventory of responsibilities, not a fixed serial execution order. Define dependencies, permitted concurrency, joins and repetition explicitly while preserving exact-candidate checks before mutation. This is a structural and behavioral migration, not a rename of the `merge` enum value. Define normal, interrupted, rejected, target-moved, policy-changed and historical-recovery transitions before implementation. A stage may be deterministic; do not create agents merely to populate the diagram.

Affected surfaces include stage enums, role/session routing, saved state, claims, prompt selection, CLI dispatch/results, caller restart policy, stage caps, labels, tests, docs, telemetry and dashboard rendering. Coordinate with the current issue-pipeline work rather than reimplementing its accepted changes from the older checkout.

## State, outcome and observation

| Existing surface | Difference | Class | Required alignment |
| --- | --- | --- | --- |
| Pipeline `Status = Stage` plus stopped/done in `src/stages.ts` | Mixes workflow position and condition | Structure | Model stage, run state, outcome and work-item completion separately. Design values and old-record mapping explicitly. |
| Dash `pidWorkflowRun()` and `live()` | Errors, including denied inspection, become false | Behavior | Preserve Unknown/unavailable separately from confirmed not live. Verify expected process identity without claiming certainty from a PID alone. |
| Dash `readCap()` and `dirs()` | Many unavailable/refused reads become empty strings/lists | Behavior | Preserve missing, denied, malformed and partial-read observations where those differences affect claims. Empty successful results must remain distinguishable. |
| Dash agent-run pending-request inference | Bounded evidence may omit uncertainty | Behavior | Distinguish no observed request from unavailable/incomplete evidence. Do not treat generic attention state as a confirmed pending question. |
| Dash GitHub cache and view filters | Capped at 100 per kind/repository; migration issues excluded; agent-run default is today-only | Observation contract | Disclose scope, observation time, cache freshness, omissions and incompleteness. A compact view need not collect everything, but must not imply complete coverage. |
| Status-report | Already separates field authority, execution evidence, assignment, gaps and conflicts | Terminology and contract alignment | Retain stronger uncertainty rules while adopting canonical run/work-item/assignee terms. Its read-only collection budget is not an execution budget for other tools. |
| Issue-pipeline gate evidence | Test success, observer failure, cleanup coverage and reservation release differ | Observation contract | Preserve all four independently. An observer denial does not change the authoritative test exit result or establish exhaustive cleanup. |

Do not add watchers to status-report to match dash. Dash is a refreshed view; status-report is a bounded snapshot. Shared meanings do not require identical collection policies or a shared collector implementation.

## Requests, authorization and artifacts

| Existing surface | Required alignment | Class |
| --- | --- | --- |
| Dash action templates and `composeInstruction()` | Describe requests to the caller. Preserve user editing, cancel behavior and no direct process/GitHub control. | Terminology and invariant preservation |
| Pipeline signed state, claims, policy bindings, review and Security records | Replace with GitHub artifacts under the task app model. Keep historical records as they are; a diagnostic artifact or backup push does not grant action authority. | Structure review |
| Attempted merge versus confirmed result | An attempted merge is not a merge. Unknown results require observations and reconciliation, such as reading the PR's merged state, not a repeated write. | Invariant preservation |
| New buddy or task names | Do not infer privileges from role, assignment, stage label, report contents or available credentials. | Invariant preservation |
| Assessment reports | Behavioral gaps/public entry points only; matching Markdown/JSON and identical randomized order; no receiving-agent implementation. | New artifact contract |

Historical evidence may retain old vocabulary. Preserve original bytes, signatures and hashes; expose a faithful interpretation instead of editing signed records or making historical authorization appear current.

## Lanes, slots and reservations

| Existing surface | Required alignment | Class |
| --- | --- | --- |
| Pipeline stable `--lane` claimant across jobs | Retain lane as a coordination identity, not capacity. Map claim and run identities separately. | Terminology and identity review |
| Historical dash `pipeline_lanes`, capacity pills and refill-lanes template | Canonical tools now use `workflow_runs`/`workflow_run`; capacity and requests use run counts and available workflow slots within configured limits. Old tools retain deprecated compatibility contracts. Author/Implementation and Hardening group labels do not establish observed scheduler configuration. | Terminology; public tool impact |
| Pipeline/PB environment slots and retained checkouts | Keep slot allocation tied to registered consumers, not issue closure or latest run termination. | Resource invariant preservation |
| Parent's heavy-test reservation | Keep reservation distinct from slot or lane. Explicit release and cleanup evidence remain separate. | Terminology and resource-contract review |
| Dash hard-coded four-job capacity versus the six-job pool configured since `42a8771` was installed | Separate display assumption, configured limit, accepted policy and observed utilization. This inspection did not establish live configuration. | Behavior and provenance |

Do not copy the pipeline's capacities or environment layout into the assessment app. Its accepted disposable-container boundary is a separate app policy; that does not authorize retrofitting a pipeline OS sandbox or session budgets.

## Plans and documentation

- **Ecosystem docs and README:** link the glossary during implementation and reconcile stage, role, run and authority descriptions against the version they actually describe.
- **Dash docs and tests:** align Agent runs, Caller and capacity wording; verify observations and request boundaries, not copied prose alone.
- **Status-report skill, source guide and template:** adopt canonical terms while preserving read-only scope, explicit joins, field-level authority and incomplete-source reporting.
- **Issue-pipeline plan:** coordinate updates with its maintaining session. Do not rewrite historical failures, exact-head acceptance, live authorizations or retained recovery evidence. Map completed history without making intended changes appear installed.
- **Assessment plan:** align provisional operator-run/job wording after its caller and run interfaces are designed. Preserve all accepted assessment constraints and unresolved questions. Domain alignment does not authorize implementing its receiving agent.

## Migration sequence

1. Review the glossary and this inventory with Autumn; settle the unresolved contracts.
2. Recheck active source versions and coordinate ownership with current pipeline work.
3. Design canonical identifiers, schemas, stage transitions and compatibility boundaries.
4. Make terminology-only source changes in coherent groups, including affected docs/config readers and behavioral tests.
5. Implement observation corrections with tests for denied, missing, malformed, partial, conflicting and successfully empty evidence.
6. Implement the task model with recovery and exact-authorization tests, coordinated with the accepted behavior branches.
7. Align dash, status-report and plan references with the resulting contracts.
8. Review and verify source changes; report source delivery separately from installation or activation.

This sequence is proposed. It does not select a source branch, authorize concurrent writers or grant an install/cutover.

## Acceptance criteria

- Every shared concept has one canonical name in current code and documents; retained old names exist only at explicit historical or migration boundaries.
- Work-item identity, run identity, session identity, assignment and observed execution stay distinct.
- Issue delivery exposes the accepted flat tasks with explicit prerequisites, permitted concurrency, joins and tested recovery transitions; a task list does not impose a serial schedule.
- Merge refers only to a Git merge; landing, accounts, queues and labels use landing names.
- Public configuration, tools, CLI and persisted records have an agreed compatibility policy; no silent aliases or unsafe reinterpretation appear.
- Unknown, unavailable and partial evidence never becomes a false negative, an empty result or a completion claim.
- Dependencies identify specific required results, conditions and permissions, bound to the relevant revision, target state, policy and authorization scope, rather than completion of unrelated tasks. Historical results are preserved without treating them as applicable to a new revision.
- Requests do not bypass authorization; role, buddy and task names and capabilities grant no extra authority.
- Historical task records keep their original bytes and scope, and no task app reads them; uncertain writes are never blindly repeated.
- Slot and reservation release respect registered consumers and explicit release conditions.
- Status-report remains read-only; dash remains an observation/request interface, not a second scheduler.
- Behavioral tests prove the changed contracts at the lowest appropriate level; no flaky pass, weakened guard or copied-prose assertion establishes acceptance.

## Open decisions

- Canonical serialized identifiers. Run states are settled; task-result verdicts are passed, failed, refused or unknown.
- Identity/linkage for historical jobs, launches and externally managed Pi runs/sessions.
- Configuration and CLI migration, historical readers, supported upgrade direction and removal of transitional readers.
- The hidden markers that task apps use to find their own comments. Results, prerequisites and recovery come from GitHub, as the [domain runtime contract](domain-runtime-contract.md) describes.
- Compatibility for renamed labels, saved state, CLI flags and configuration keys.
- Observation schemas, freshness bounds and explicit coverage representation. Sources are settled.
- Configured capacity provenance, and whether any capacity limit survives the launcher. Capacity is counted by resource and released by registered consumers.
- Whether Land should read the trusted `permissions.land` grant again. The Land task app (#253) doesn't: GitHub's permissions on its buddy's account decide whether it can merge.
- Dash's destination and tooling/install integration inside ecosystem; the decision to add it there is accepted and tracked by `add-pipeline-dash-to-ecosystem`.
- Whether glossary work should move to its own shared plan; it is currently tracked in `~/brain/plans/stryker-test-assessment.md`.
