# Shared domain glossary

This draft records the domain language Autumn accepted for ecosystem, the Pi dash extension, the status-report skill and the test-suite assessment app. Use one canonical term for each shared concept. Different names remain only when they describe different concepts.

These definitions describe the intended domain. They do not claim that existing code, saved records or installed tools already conform. The [domain alignment inventory](docs/domain-alignment.md) identifies known differences and migration decisions. Historical names there are migration references, not permanent synonyms.

## People, roles and buddies

### Operator

The human responsible for installation and operational configuration.

Starting a run does not by itself make someone an operator, and a buddy is not an operator.

### Role

A set of tasks that are its responsibilities: the work that role should do.

A role holds no identity, credentials or authority. It does not establish authorization or available capabilities. A role need not use a model; a role whose tasks are deterministic is still a role. Each buddy has one role.

### Developer

The role responsible for the Author, Implement and Fix tasks, and for Safe Refactor when it is explicitly assigned. Use Developer instead of Implementor wherever they name the same role. Implement is the task, not the role's name.

### Gatekeeper

The role responsible for the Verify and Land tasks. It verifies and lands what the Developer writes.

### Account

An external principal that holds credentials, such as a GitHub user or a model provider key.

Several identities may share an account. GitHub's event `actor` field names an account, observed as external data; it is not a buddy.

### Identity

The settings and credentials a buddy uses: its accounts, model and runtime settings, access profile and network policy.

An identity is a capability. It makes an action possible; it does not authorize it.

### Buddy

A thin configuration wrapper pairing scope, responsibilities and identity. Scope identifies where it may work; responsibilities identify its tasks, which a role may group; identity supplies its accounts and runtime settings. For example, Hippy pairs Developer responsibilities with the development identity and configured repository scope.

A task stands on its own. The buddy does not own the task's sensors, inbox, signal matching or actions, and does not duplicate its behavior. Pairing a task with a different scope or identity does not redefine that task. Trusted configuration grants standing permission within the paired scope and responsibilities; task prerequisites and action-specific guards still apply. GitHub issue assignment is not required.

A buddy run activates its configured tasks' action loops. Work discovery uses the tasks' declared sensors within the configured scope.

A task doesn't have to be split because one side writes and the other checks ([no-separate-duties](docs/decisions/pr-review.md#no-separate-duties)). The Developer and the Gatekeeper still use separate GitHub accounts, because GitHub doesn't let a pull request's author approve or request changes on it. [Buddy and task decisions](docs/decisions/buddies-and-tasks.md) record the current buddies.

### Executing buddy

The buddy performing a particular run.

## Work and execution

### Work item

An independently tracked intended outcome, separate from its executions. A work item can have dependencies and a completion condition. It may require several runs or have no active run.

A plan task and a GitHub issue can represent the same work item, but equivalence requires explicit linkage. Similar titles or bare issue numbers do not establish identity.

### Run

One execution, such as invoking a tool, buddy or workflow, with its own identity, start time, state and eventual outcome.

A work item may have several runs. Runs may contain child runs. Ending a run does not necessarily complete its work item. Existing pipeline job and launch records need explicit mapping before their names or identities change.

### Buddy run

One activation of the action loops of all tasks in a buddy's configured responsibilities, using its scope and identity. Activation does not mean every task immediately acts: a loop may wait for signals or prerequisites. A buddy run is not one task execution or model session, and does not require a separate process or model session per task.

A stop propagates from the buddy run to its task loops and their active actions, including model-assisted work and deterministic operations. Each affected component stops admitting new work and passes the stop to work it started. Active work reaches a safe boundary, preserves progress and records checkpoints. Propagation is graceful, not immediate process termination, and does not undo completed effects.

Stop propagation stays within the stop's scope. An issue-level `agents:stop` affects work for that issue, not unrelated issues served by the same buddy run. Unknown action results require reconciliation, not blind repetition.

A model launch is not a buddy run.

### Retry

A new run linked to an earlier run. A retry has a new run identity. This definition does not authorize a retry or establish that repeating an uncertain action is safe.

### Resumption

Continuation of a preserved run with the same run identity. The workflow doesn't offer resumption: every restart is a retry from the latest checkpoint.

Starting a fresh run from a checkpoint is not resumption of the original run. Continuing the same session alone also does not establish run resumption. Map existing restart behavior from its actual identity and execution semantics, not its command name.

### Session

A model's retained conversation and context. A session supports model-assisted actions; its lifetime is separate from the buddy run that activates task loops. Implement's hardening runs in a fresh session that never shares the conversation of the session that wrote the change.

Session identity, run identity and checkpoint identity are not interchangeable.

### Workflow

Work and its dependency rules toward an outcome, not a fixed serial sequence. A workflow can branch, execute independent work concurrently, join results, repeat checks and recover from interruption.

Dependencies and authorization conditions determine what may proceed. A task list alone does not impose a total execution order. Use Workflow rather than Pipeline for this shared concept; retain old technical names only at explicit compatibility or historical boundaries.

### Prerequisite

A specific current result, condition or permission that a task requires before it may proceed. Dependencies identify these prerequisites, not blanket completion of all work of the same kind.

For example, landing revision R of change A requires an approving review that stands on R, and separate authorization to land it. A review of change B does not count for A. If A gets a new revision, the earlier result does not satisfy the prerequisite for it; retain it as historical evidence. A passing check is evidence, not permission.

### Workflow run

One execution of a workflow. It may contain buddy runs and deterministic tool executions. It is not necessarily the entire lifetime of a work item: retries or later work can require additional workflow runs.

Each run retains its own identity. Establish parent–child links from explicit records, not from coincident names, times or a shared issue. Dash's workflow-run and buddy-run views currently read different sources and do not establish those links.

### Task

An actor in a workflow: it declares the sensors it wants, receives their signals in an inbox, and matches signals to actions. A task may act when its prerequisites hold and produces one result for its binding. A role's tasks are its responsibilities. A task may use a model or run deterministically.

Actor here means the actor-pattern execution model. A task stands on its own, independently of the buddy configuration that pairs it with scope and identity. It owns its sensor declarations, inbox, signal matching and actions. A task is not a buddy, identity, model session or individual run. Inbox storage, delivery guarantees and actor-instance boundaries remain to be designed.

Tasks replace stages. A work item has no single current position. Its **ready tasks** are those whose prerequisites are current and whose own result for the current binding is missing. Each task owns its prerequisites, result, receipt, attempts, stop conditions and recovery, so it can change without reaching into another task's internals.

Plans also call their items tasks. Where that could be confused with a workflow task, call a plan item a work item or a plan task.

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

What a task established, bound to exactly what it applies to.

A result differs from an outcome: an outcome belongs to a run, while a result belongs to a task and its binding. A result's verdict is passed, failed, refused or unknown, separate from the producing run's outcome. A run can end successfully while its result is already stale.

### Binding

What a result applies to. For a task that checks or changes a revision, the binding is that revision, the target state and the policy.

A result is current while its binding still matches the revision, target state and policy in question. Otherwise it is stale and remains historical evidence only. Author and Implement run before any revision exists, so they bind the issue's trusted requirements instead. Verify, Fix and Land bind the pull request's head revision.

### Merge

A Git merge, and only that: a commit that joins histories, such as a pull request's merge commit.

Land's pull request merge commit and Fix's merge of the base into the head branch are both Git merges. Do not use merge for landing itself, for the work around it, or for accounts, queues or labels. GitHub reports a pull request as merged even after a fast-forward, squash or rebase; quote that as GitHub's external state, not as a domain claim.

### Verify

The Gatekeeper task that checks one exact pull request head and reports through a GitHub review. It runs the repository's full checks, the required CI and the Security review of that head. It posts inline and general review comments, then approves when it finds nothing or only nits, and requests changes otherwise. A Security finding always blocks.

Verify's review binds the head's commit, so it covers exactly what Verify checked. A new head needs a new Verify.

### Nit

A review finding that doesn't affect behavior, safety or maintainability, such as a naming preference or comment wording. A nit doesn't block approval. Verify still posts it, marked as non-blocking.

### Fix

The Developer task that answers a change that didn't pass review. A request-changes review on the current head, from Verify or a qualified person, wakes it, and so does Land finding a conflict. In one run, Fix merges the pull request's base branch into its head branch and answers every blocking comment with a code change and a thread reply. Its result is a new head, which Verify then checks.

Fix replaces going back to Implement. It is not a rebase: commits that were already reviewed keep their identity.

### Review loop

The cycle in which Verify reviews a head, Fix answers it and Verify reviews the new head. An issue gets at most three Fix rounds that Verify triggered. After the third, if Verify still requests changes, the issue holds for a person. Rounds that a person's review or Land's conflict triggered don't count.

### Land

The task that moves a target to include a revision. Land merges the pull request with a merge commit, pinned to the exact head it checked, and then closes the issue. Its result covers both, and names the merge commit M.

The landing account is the account that approves the exact revision and lands it. The landing order is the order in which revisions land on a target; it grants no permission to land.

### Safe Refactor

The Developer task that improves an existing revision's design without changing behavior under its explicitly selected preservation contract. It uses findings, practices and this glossary to choose cohesive changes, not merely reduce metric scores. Unsupported changes are deferred with reasons.

Safe Refactor does not replace Implement's hardening or Verify, and grants no Land authority. Changed source needs a newly bound revision and fresh downstream results. The initial standalone implementation returns unsigned reports, not authenticated workflow Results or Receipts; the [Safe Refactor reference](docs/reference/safe-refactor.md) describes its limits.

### Refactoring primitive

A named operation with a fixed preservation contract, applicability preconditions and constrained arguments. Library availability and applicability do not establish preservation, authorization or design quality. The tool, not model-supplied source or prompt compliance, controls every edit.

An operation can produce edits, checks and a checkpoint. Ending that operation does not by itself establish a task Result or authorize another action.

### Issue delivery

The workflow that develops and delivers an issue's intended change. Its tasks are flat; the table is not an executable sequence. Author is optional. Independent work may proceed concurrently where the dependency and authorization rules permit it.

| Task | Becomes ready when | Result |
| --- | --- | --- |
| Author | `start:author` | Gherkin requirements |
| Implement | `start:implement` | A hardened pull request head |
| Verify | A head with no Verify result, or `start:verify` | A submitted review on that exact head |
| Fix | A blocking review on the current head, or Land finding a conflict | A new head that answers the review and contains the base |
| Land | An approved head that is ready to merge | The pull request merged and the issue closed |

When Fix produces a new head, every earlier review and result stays bound to the old one. Verify becomes ready for the new head; no task moves backwards. Concurrency does not weaken existing verification, revision, target or policy requirements.

The Developer performs Author, Implement and Fix, and Safe Refactor when it is explicitly assigned; Safe Refactor adds no automatic dispatch or fixed workflow position. The Gatekeeper performs Verify and Land. The [PR review decisions](docs/decisions/pr-review.md) record this model. This intended model does not describe every historical or installed version.

### Run state

The run's execution condition, distinct from the tasks it performs, its outcome and observed process liveness.

A run is running; waiting, when a prerequisite or hold is unmet; stopped, when it needs a person and its work is kept; or ended, with an outcome. A recorded running value is not proof that a process is live.

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

A lost response does not prove that the action failed. Reconciliation does not authorize repeating an action to obtain a clearer result. Preserve conflicting evidence rather than silently selecting a convenient claim.

## Requests, authority and records

### Request

An expression of desired work or action.

A request can convey authorization from an authorized person. Arbitrary request text does not grant authorization.

### Signal

A message representing a condition or occurrence detected by a sensor, carrying its evidence and human or machine provenance. A signal need not be an explicit request. A task matches signals to actions; the signal alone does not prescribe an action or grant permission.

A human-produced signal qualifies only when its producer is a current member of the configured organization. A machine-produced signal qualifies through the applicable authentication, provenance and binding rules. Signals encapsulate this distinction so tasks do not each invent producer-specific authority checks. Verify the applicable authority at run start and before privileged effects that rely on it. Unknown evidence grants no permission.

An issue having `start:author`, `start:implement` or `start:verify` can supply a signal matched to starting that task. A qualified person's review of the issue's pull request is a signal too, bound to the head it reviewed. `agents:stop` supplies a signal matched to preventing new task runs and gracefully stopping active runs at the next safe boundary, preserving work and recording checkpoints. For a label-based signal, verify the application event and its producer; label presence alone does not establish authority.

Removing a label is never a signal. Removing a start label does not cancel accepted work. Removing `agents:stop` does not authorize continuation. The signal for continuation remains undefined.

These are intended contracts, not claims about installed behavior. [Signal authority decisions](docs/decisions/authority.md#signal-authority) record their authority rules.

### Sensor

A mechanism that detects signals from a source and populates the inboxes of tasks that declare they want that sensor. A sensor can detect a condition, such as an issue having a label, rather than only a new event. It retains the evidence and provenance needed to qualify the signal; an incomplete read does not establish absence or permission.

### Action

An operation a task selects by matching a signal, subject to current prerequisites and authority. Actions can update labels, launch model-assisted work, execute deterministic checks, or record results and checkpoints. Actions may produce conditions or evidence that sensors detect as further signals.

Shared execution guards enforce scope, responsibility, authority, ownership, capacity and stop controls. Matching a signal never bypasses those guards.

### Authorization

Permission to perform a specific action within defined scope and conditions.

A role, an observation or possession of a capability does not by itself establish authorization.

### Capability

The technical means to perform an action, such as an available tool, credential or identity. Capability does not establish authorization.

Dash composes requests for the session it runs in; it does not directly control workflow execution. Status-report observes work; it does not manage it.

### Artifact

A durable output, such as a report, patch or test log. Checkpoints and receipts are artifacts with different purposes.

### Checkpoint

A saved progress record used to continue work.

A checkpoint recording that landing was requested is not a receipt confirming that the revision landed.

### Receipt

The authenticated record that a task produced a result, bound to its identity and the result's binding.

Record is plain English, not a domain term. Name the actual kind: receipt, checkpoint, run record or observation.

A receipt is evidence, not automatic authorization for another action. Existing authentication, provenance and exact-result requirements still apply.

## Resources and coordination

### Lane

A stable coordination identity carried across related runs. A lane is not a unit of capacity and may outlive an individual run.

Use run count or capacity when those are the actual meaning; do not call them lanes.

### Slot

One reusable allocation from a bounded pool, such as an isolated test environment.

A slot is released only when every registered consumer reports it's done. It can remain occupied after a run ends. Idle observations, an unknown consumer state or work-item completion do not establish release.

### Reservation

A recorded claim to use a resource under defined conditions, such as exclusive use of heavy-test capacity.

A reservation is not a lane or a slot. Preserve the applicable release conditions and registered consumers.

## Assessment handoff

The assessment app uses these accepted product terms. It is an adversarial assessment instrument, not a review layer or a remediation agent.

### Behavioral gap

A testing opportunity concerning observable behavior. Source-aware analysis or mutation testing may identify it; a corresponding mutation is not required.

Describe suspected failures as testing gaps, not confirmed bugs. When expected behavior is ambiguous, state an open behavioral question rather than inventing an expected answer.

### Public entry point

The externally usable interface through which the relevant behavior can be exercised. Identify it without prescribing tests of private implementation details.

### Open behavioral question

A testing gap expressed without an established expected answer because behavior is undocumented or ambiguous.

### Handoff report

The assessment artifact containing behavioral gaps and relevant public entry points for independent investigation.

Generate matching Markdown and JSON reports from the same assessment data, with identical randomized gap order. Do not include exact mutation details or isolate suspected failures in a separate bug section. The assessment build ends at these artifacts; implementation or launch of the receiving agent is outside its scope.

## Definitions still required

[Buddy and task decisions](docs/decisions/buddies-and-tasks.md) settle the buddy, role, identity and account schemas; the role assignments; ready tasks and their bindings, including Author's and the first Implementation's; repeated checks and task order; run states and retries; the capacity unit, slot release and shared reservations; observation sources, freshness and coverage; who lands and installs; and additive record versions. These contracts remain open:

- Which binding parts apply to each task, and the remaining prerequisite and result schemas.
- Observation schemas.

Resolve these contracts before implementing dependent changes. Do not fill missing facts or permissions with inferred defaults.
