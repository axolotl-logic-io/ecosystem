# Shared domain glossary

This glossary records the domain language for ecosystem and its workflow dashboard. Use one canonical term for each shared concept. Different names remain only when they describe different concepts.

## People and buddies

### Operator

The human responsible for installation and operational configuration.

Starting a run does not by itself make someone an operator, and a buddy is not an operator.

### Account

An external principal that holds credentials, such as a GitHub user or a model provider key.

Each buddy has its own GitHub account, and no two buddies share one. A GitHub event's `actor` field names an account, observed as external data. Because each account belongs to one buddy, the `actor` identifies the buddy that acted. Buddies may still share a model provider key.

### Identity

The settings and credentials a buddy uses: its GitHub account, its model provider keys, model and runtime settings, access profile and network policy.

An identity is a capability. It makes an action possible; it does not authorize it.

### Buddy

A thin configuration wrapper pairing scope, responsibilities and identity. Scope identifies where it may work; responsibilities identify its explicit tasks; identity supplies its account and runtime settings. For example, Hippy can launch Gherkin, Implement and Fix in its configured repository scope.

A buddy is a launcher. It watches the issues in its scope for start labels of its tasks and runs the matching [task app](#task-app) for each one. It checks no prerequisite first: the task app's [claim](#claim) decides which buddy runs a start. A task stands on its own, and pairing it with a different scope or identity does not redefine it. GitHub issue assignment is not required.

Verify must refuse a PR authored by its executing account. GitHub does not let a PR's author approve or request changes on it.

### Executing buddy

The buddy performing a particular run.

## Work and execution

### Work item

An independently tracked intended outcome, separate from its executions. A work item can have dependencies and a completion condition. It may require several runs or have no active run.

A plan task and a GitHub issue can represent the same work item, but equivalence requires explicit linkage. Similar titles or bare issue numbers do not establish identity.

### Run

One execution, such as invoking a tool, buddy, task app or workflow, with its own identity, start time, state and eventual outcome.

A work item may have several runs. Runs may contain child runs. Ending a run does not necessarily complete its work item.

The task framework writes one run record for each task run that wins its claim, so that the workflow dashboard can show it. A run record is an observation, not authority, and no later run continues from it.

### Buddy run

One activation of a buddy's launcher, using its scope and identity. While it runs, it starts a task run for each start label it sees. A buddy run is not one task run or model session.

A model launch is not a buddy run.

### Retry

A new run of a task, started by applying its start label again. A retry has a new run identity.

Every run, retry or not, continues from what earlier runs left on GitHub: comments, the branch, the pull request and its reviews. A retry therefore does not repeat work that is already on GitHub. Nothing retries automatically: a failed run posts a comment that says to apply the start label again, and never applies it itself.

### Resumption

Continuation of the same run, with the same run identity. The workflow doesn't offer resumption. A run that ends stays ended, and new work happens in a new run that continues from GitHub.

Continuing the same model session alone does not establish run resumption.

### Session

A model's retained conversation and context. A session supports model-assisted work within a task run; its lifetime is separate from the run's. Implement's hardening runs in a fresh session that never shares the conversation of the session that wrote the change.

Session identity and run identity are not interchangeable.

### Workflow

Work and its dependency rules toward an outcome, not a fixed serial sequence. A workflow can branch, execute independent work concurrently, join results, repeat checks and recover from interruption.

Dependencies and authorization conditions determine what may proceed. A task list alone does not impose a total execution order. Use Workflow rather than Pipeline for this shared concept.

### Prerequisite

A specific current result, condition or permission that a task requires before it may proceed. Dependencies identify these prerequisites, not blanket completion of all work of the same kind. A task reads its prerequisites from GitHub when it runs. A missing prerequisite ends the run with a comment that names it; it does not keep the task from starting.

For example, landing revision R of change A requires an approving review that stands on R. A review of change B does not count for A. If A gets a new revision, the earlier review does not satisfy the prerequisite for it; it stays on GitHub as evidence about the old revision. A passing check is evidence, not permission.

### Workflow run

One execution of a workflow. It may contain buddy runs and deterministic tool executions. It is not necessarily the entire lifetime of a work item: retries or later work can require additional workflow runs.

Each run retains its own identity. Establish parent–child links from explicit records, not from coincident names, times or a shared issue.

### Task

A unit of workflow work that only its start label starts, built as a [task app](#task-app) on the shared task framework. A buddy's configured tasks are its responsibilities. A task may use a model or run deterministically.

The framework runs four lifecycle steps for every task run:

1. **Claim:** take the start, as described under [Claim](#claim).
2. **Mark:** add the task's [running label](#running-label).
3. **Work:** run the task's own work. This is the only step a task supplies.
4. **Unmark:** remove the running label, unless another run of the task is still live.

If a run fails after its claim, the framework posts a comment on the issue that names the task, the failed step and the error. A task is not a buddy, identity, model session or individual run.

Tasks replace stages. A work item has no single current position. Each task reads what it needs from GitHub, so it can change without reaching into another task's internals.

Plans also call their items tasks. Where that could be confused with a workflow task, call a plan item a work item or a plan task.

### Task app

A task's command-line program, built on the task framework and installed as `TASK.mjs` in the install root. A buddy runs it as `TASK.mjs --invocation`: it reads the task, issue, account and repository settings from standard input and receives the account's credentials on descriptor 3. It never sees a buddy file. For compatibility, an operator can still run it by hand as `TASK.mjs --config BUDDY_FILE --issue OWNER/REPO#N`. It exits 0 when the run ends normally, including when it loses its claim, and nonzero when the run fails.

### Claim

A buddy's removal of `start:X`, confirmed on the issue timeline as made by its own account.

Several buddies can see the same start at once. Each one tries to remove the label, and the first `unlabeled` event after the start's `labeled` event decides the winner. A buddy that loses ends quietly: it neither marks the issue nor comments. A buddy that can't confirm the removal ends and comments that the start couldn't be confirmed.

### Running label

`agent:X:running`, which shows that a run of task X is live. It never gates a start: a new `start:X` is claimed even while a run of X is live, so two runs of one task can overlap.

A run removes the label only when every claim it sees on the timeline has an end comment. A run that crashes leaves the label in place, and a person removes it.

### Change

The modification a work item intends. A change keeps one identity across all its revisions. A branch and a pull request represent it.

### Revision

One exact, immutable version of a change: its code commit, its trusted inputs and its policy.

Use revision rather than candidate or version. A head or head SHA is the revision's code commit, a Git-level detail.

### Target state

The target branch observed at an exact commit: its repository, branch and commit.

### Target

The program element or elements a refactoring primitive intends to affect. This is not the workflow's target state.

A Target description does not identify a source version or grant write authority. Resolve it against the exact source and refuse ambiguous or stale matches rather than introduce separate selector and resolved-target entities.

### Result

What a task established, recorded as a GitHub artifact, such as a comment, a review on a head commit, a pushed head or a merge. GitHub is the only record of a task's earlier work.

A result differs from an outcome: an outcome belongs to a run, while a result belongs to a task and its binding. A run can end successfully while its result is already stale.

### Binding

What a result applies to. A result's artifact names its own binding: Verify's binding to a head is the commit its review was submitted on, and Land's is the head its merge matched.

A result is current while its binding still matches the revision in question. Otherwise it is stale and remains evidence about an earlier revision only. A Gherkin comment applies to the issue it answers, not to a revision.

### Merge

A Git merge, and only that: a commit that joins histories, such as a pull request's merge commit.

Land's pull request merge commit and Fix's merge of the base into the head branch are both Git merges. Do not use merge for landing itself, for the work around it, or for accounts, queues or labels. GitHub reports a pull request as merged even after a fast-forward, squash or rebase; quote that as GitHub's external state, not as a domain claim.

### Gherkin

The task that writes an issue's behavior as Gherkin scenarios, or asks the questions only the issue's author can answer. It is named after the method it follows. Only `start:gherkin` starts it.

Its result is a Gherkin comment on the issue. A rerun edits its own earlier Gherkin comment rather than posting a second one.

### Implement

The task that writes the change an issue asks for on the branch `agent/issue-N`, hardens it in a fresh session and opens a pull request. Only `start:implement` starts it. Its result is the pushed head of a pull request marked ready for review.

### Verify

The task that checks one exact pull request head and reports through a GitHub review. Only `start:verify` starts it, and it reviews the head as it is when the run starts. It runs the repository's full checks, the required CI and the Security review of that head. It posts inline and general review comments, then approves when it finds nothing or only nits, and requests changes otherwise. A Security finding always blocks.

Verify's review binds the head's commit, so it covers exactly what Verify checked. A new head needs a new Verify.

### Nit

A review finding that doesn't affect behavior, safety or maintainability, such as a naming preference or comment wording. A nit doesn't block approval. Verify still posts it, marked as non-blocking.

### Fix

The task that answers a change that didn't pass review. Only `start:fix` starts it; a request for changes or a conflict doesn't. In one run, Fix merges the pull request's base branch into its head branch and answers every unresolved blocking comment on the current head with a code change and a thread reply. Its result is a new head, which a new `start:verify` checks.

Fix replaces going back to Implement. It is not a rebase: commits that were already reviewed keep their identity.

### Review loop

The cycle in which Verify reviews a head, Fix answers it and Verify reviews the new head. An issue gets at most three Fix rounds that Verify triggered. Fix counts them from the pull request's reviews by Verify's account. After the third, if Verify still requests changes, Fix ends with a comment asking a person to step in. A person's review or Land's conflict doesn't count toward the limit.

### Land

The task that moves a target to include a revision. Only `start:land` starts it; an approved head doesn't. Land merges the pull request with a merge commit, pinned to the exact head it checked, and then closes the issue. Its result covers both, and names the merge commit M.

Land merges through its own buddy's account. The landing order is the order in which revisions land on a target; it grants no permission to land.

### Safe Refactor

The task that improves an existing revision's design without changing behavior under its explicitly selected preservation contract. It uses findings, practices and this glossary to choose cohesive changes, not merely reduce metric scores. Unsupported changes are deferred with reasons.

Safe Refactor does not replace Implement's hardening or Verify, and grants no Land authority. Changed source needs a new revision and fresh downstream results. Safe Refactor keeps its standalone entrypoint, has no start label and returns local reports, not workflow results on GitHub; the [Safe Refactor reference](docs/reference/safe-refactor.md) describes its limits.

### Refactoring primitive

A named operation with a fixed preservation contract, applicability preconditions and constrained arguments. Library availability and applicability do not establish preservation, authorization or design quality. The tool, not model-supplied source or prompt compliance, controls every edit.

An operation can produce edits and checks. Ending that operation does not by itself establish a task result or authorize another action.

### Issue delivery

The workflow that develops and delivers an issue's intended change. Its tasks are flat; the table is not an executable sequence. Gherkin is optional. Every task becomes ready only when its start label is applied. Independent work may proceed concurrently where the dependency and authorization rules permit it.

| Task | Becomes ready when | Result |
| --- | --- | --- |
| Gherkin | `start:gherkin` is applied | A Gherkin comment, or questions for the issue's author |
| Implement | `start:implement` is applied | A hardened pull request head |
| Verify | `start:verify` is applied | A submitted review on the head it checked |
| Fix | `start:fix` is applied | A new head that answers the review and contains the base |
| Land | `start:land` is applied | The pull request merged and the issue closed |

A task whose prerequisites are missing when it runs ends with a comment that names them. When Fix produces a new head, every earlier review stays bound to the old one, and a new `start:verify` checks the new head; no task moves backwards. Concurrency does not weaken existing verification, revision, target or policy requirements.

A buddy lists its tasks explicitly. Safe Refactor adds no automatic dispatch or fixed workflow position. Verify must use an account different from the PR author.

### Run state

The run's execution condition, distinct from the tasks it performs, its outcome and observed process liveness.

A run is running; waiting, when a prerequisite or hold is unmet; stopped, when it needs a person; or ended, with an outcome. A recorded running value is not proof that a process is live.

### Outcome

What a run achieved or why it ended. Outcome is distinct from run state and work-item completion.

For example, an Implement run may end successfully while its work item still awaits Verify and Land.

### Work-item completion

Fulfillment of the work item's intended outcome under its completion conditions.

A closed issue, landed revision or ended run alone does not establish completion. Do not use status as an interchangeable name for the tasks that may proceed, run state, outcome and work-item completion.

## Observation and uncertainty

### Observation

Evidence collected about work or execution, recording its source, observation time and limits or uncertainty.

Preserve unknown and unavailable evidence as such. A partial, stale or conflicting read makes the fact unknown, and unknown never counts as success, failure or absence. An unavailable source is not an empty result. Denied process inspection does not prove a run is not live. Absence of observed activity does not establish that a resource is available.

Recorded run state, observed liveness, test outcome and cleanup coverage are separate facts. Passing tests can coexist with unverified cleanup.

### Reconciliation

Collection and comparison of observations to establish an uncertain action result.

A lost response does not prove that the action failed. For example, Land settles a lost merge response by reading the pull request's merged state. Reconciliation does not authorize repeating an action to obtain a clearer result. Preserve conflicting evidence rather than silently selecting a convenient claim.

## Requests, authority and records

### Request

An expression of desired work or action.

A request can convey authorization from an authorized person. Arbitrary request text does not grant authorization.

### Signal

A condition on GitHub that a task or buddy acts on. The only start signal is a `start:X` label on the issue, where X is the task. `agents:stop` on the issue is the only stop signal.

Trust comes from GitHub's permissions. Only accounts with triage access or higher can add labels to an issue, so a start label being present is enough to start its task. The task framework doesn't check who applied it. Issue text from other people is still untrusted input to model sessions.

A review, a task result, an assignment or a status label never starts a task. A buddy's claim removes the start label; removing a start label by hand before a claim withdraws the start.

### Stop

The hold that `agents:stop` places on an issue while it's there. It holds claims, so a `start:X` stays on the issue unclaimed, and it ends live runs. The task framework checks for it before a claim, between lifecycle steps and before each write to GitHub. A run that sees it ends at that point, comments and unmarks.

Nothing is latched. When someone removes `agents:stop`, the next poll claims any start label still on the issue. A stop does not undo completed effects, and it stays within its issue: it doesn't affect other issues a buddy serves.

### Action

An operation a task run performs during its work, such as pushing commits, submitting a review, merging or commenting. Actions produce the GitHub artifacts that later runs read.

Shared guards enforce scope, responsibility and stop controls before each action that writes to GitHub.

### Authorization

Permission to perform a specific action within defined scope and conditions.

A task name, an observation or possession of a capability does not by itself establish authorization.

### Capability

The technical means to perform an action, such as an available tool, credential or identity. Capability does not establish authorization.

The workflow dashboard composes requests for the session it runs in; it does not directly control workflow execution.

### Artifact

A durable output, such as a report, patch, test log, comment, review or pushed commit. A task's results are GitHub artifacts, and a run keeps no state between runs.

Record is plain English, not a domain term. Name the actual kind: comment, review, run record or observation.

An artifact is evidence, not automatic authorization for another action. A task still reads its own prerequisites when it runs.

## Resources and coordination

### Lane

A stable coordination identity carried across related runs. A lane is not a unit of capacity and may outlive an individual run.

Use run count or capacity when those are the actual meaning; do not call them lanes.

## Definitions still required

These contracts remain open:

- The hidden markers that task apps use to find their own comments ([#290](https://github.com/axolotl-logic-io/ecosystem/issues/290)).
- Observation schemas ([#291](https://github.com/axolotl-logic-io/ecosystem/issues/291)).

Resolve these contracts before implementing dependent changes. Do not fill missing facts or permissions with inferred defaults.
