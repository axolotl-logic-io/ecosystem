# Shared domain glossary

This draft records the domain language Autumn accepted for ecosystem, the Pi dash extension, the status-report skill and the test-suite assessment app. Use one canonical term for each shared concept. Different names remain only when they describe different concepts.

These definitions describe the intended domain. They do not claim that existing code, saved records or installed tools already conform. The [domain alignment inventory](docs/domain-alignment.md) identifies known differences and migration decisions. Historical names there are migration references, not permanent synonyms.

## People, roles and actors

### Operator

The human responsible for installation and operational configuration.

An operator can also act as a caller, but these are different responsibilities. Starting a run does not by itself make someone an operator, and an actor is not an operator.

### Caller

The person or program that selects work, invokes tools and handles their results.

Use caller instead of orchestrator wherever both name this responsibility. A caller may coordinate multiple runs. That coordination does not grant installation, landing or other action authority.

### Assignee

The person or actor explicitly assigned to a work item.

Use assignee rather than owner when the meaning is work assignment. Do not infer assignment from execution or from who must answer a question. Ownership of resources remains a separate concept.

### Role

A set of tasks that are its responsibilities: the work that role should do.

A role holds no identity, credentials or authority. It does not establish authorization or available capabilities. A role need not use a model; a role whose tasks are deterministic is still a role.

### Developer

The canonical role responsible for the Implementation task. Use Developer instead of Implementor wherever they name the same role. Implementation is the task, not the role's name.

### Account

An external principal that holds credentials, such as a GitHub user or a model provider key.

Several identities may share an account. GitHub's event `actor` field names an account, observed as external data; it is not an actor in this glossary.

### Identity

The settings and credentials an actor uses: its accounts, model and runtime settings, access profile and network policy.

An identity is a capability. It makes an action possible; it does not authorize it.

### Actor

A role paired with an identity. For example, Developer with the development account and a model, or a landing actor with the landing account and no model.

Actors whose duties must stay independent have decoupled identities. Security and Hardening are performed by separate actors with separate identities and accounts.

### Executing actor

The actor performing a particular run. It may differ from the work item's assignee.

## Work and execution

### Work item

An independently tracked intended outcome, separate from its executions. A work item can have dependencies, an assignee and a completion condition. It may require several runs or have no active run.

A plan task and a GitHub issue can represent the same work item, but equivalence requires explicit linkage. Similar titles or bare issue numbers do not establish identity.

### Run

One execution, such as invoking a tool, actor or workflow, with its own identity, start time, state and eventual outcome.

A work item may have several runs. Runs may contain child runs. Ending a run does not necessarily complete its work item. Existing pipeline job and launch records need explicit mapping before their names or identities change.

### Actor run

A run in which an actor performs tasks from its role. An actor run is a run, not a session; it may use a session. A run that uses no model, such as a Land run, is still an actor run.

Use **Actor runs** for dash's run view, and show each run's account. Operators and Agent runs were its historical labels. An actor run may participate in a workflow run or operate independently.

Avoid agent as a domain term because it is overloaded. Where it remains, an agent run means an actor run whose identity includes a model.

### Retry

A new run linked to an earlier run. A retry has a new run identity. This definition does not authorize a retry or establish that repeating an uncertain action is safe.

### Resumption

Continuation of a preserved run with the same run identity.

Starting a fresh run from a checkpoint is not resumption of the original run. Continuing the same session alone also does not establish run resumption. Map existing restart behavior from its actual identity and execution semantics, not its command name.

### Session

A model's retained conversation and context. One session can support multiple actor runs.

Session identity, run identity and checkpoint identity are not interchangeable.

### Workflow

Work and its dependency rules toward an outcome, not a fixed serial sequence. A workflow can branch, execute independent work concurrently, join results, repeat checks and recover from interruption.

Dependencies and authorization conditions determine what may proceed. A task list alone does not impose a total execution order. Use Workflow rather than Pipeline for this shared concept; retain old technical names only at explicit compatibility or historical boundaries.

### Prerequisite

A specific current result, condition or permission that a task requires before it may proceed. Dependencies identify these prerequisites, not blanket completion of all work of the same kind.

For example, landing revision R of change A requires a current passing Security result bound to R and the target state, and separate authorization to land it. Unrelated security work on change B does not block A. If A gets a new revision, the earlier result does not satisfy the prerequisite for it; retain it as historical evidence. A passing check is evidence, not permission.

### Workflow run

One execution of a workflow. It may contain actor runs and deterministic tool executions. It is not necessarily the entire lifetime of a work item: retries or later work can require additional workflow runs.

Each run retains its own identity. Establish parent–child links from explicit records, not from coincident names, times or a shared issue. Dash's workflow-run and actor-run views currently read different sources and do not establish those links.

### Task

A unit of a workflow that may proceed when its prerequisites hold, and that produces one result. A role's tasks are its responsibilities. A task may use a model or run deterministically.

Tasks replace stages. A work item has no single current position: the tasks that may proceed are those whose prerequisites are current and whose own result is not. Each task owns its prerequisites, result, receipt, attempts, stop conditions and recovery, so it can change without reaching into another task's internals.

Plans also call their items tasks. Where that could be confused with a workflow task, call a plan item a work item or a plan task.

### Stage

Retired. Stage named a position in a fixed sequence, which hid the dependencies between tasks. It survives only as an installed technical name; the [domain alignment inventory](docs/domain-alignment.md) maps each installed stage onto tasks.

### Change

The modification a work item intends. A change keeps one identity across all its revisions. A branch and a pull request represent it.

### Revision

One exact, immutable version of a change: its code commit, its trusted inputs and its policy.

Use revision rather than candidate or version. A head or head SHA is the revision's code commit, a Git-level detail.

### Target state

The target branch observed at an exact commit: its repository, branch and commit.

### Result

What a task established, bound to exactly what it applies to.

A result differs from an outcome: an outcome belongs to a run, while a result belongs to a task and its binding. A run can end successfully while its result is already stale.

### Binding

The revision, target state and policy that a result applies to.

A result is current while its binding still matches the revision, target state and policy in question. Otherwise it is stale and remains historical evidence only.

### Merge

A Git merge, and only that: a commit that joins histories, such as a pull request's merge commit.

Do not use merge for landing, for the work around it, or for accounts, queues or labels. GitHub reports a pull request as merged even after a fast-forward, squash or rebase; quote that as GitHub's external state, not as a domain claim.

### Land

The task that moves a target to include a revision. Its result is that revision R landed on the target at commit M. Landing may use a fast-forward or a merge.

The landing account is the account that approves the exact revision and lands it. The landing order is the order in which revisions land on a target; it grants no permission to land.

### Sync

An operation within Integration that rebases a revision onto a target state and resolves conflicts. Its result is a new revision, which needs its own Hardening result. Sync is not a merge and not a task.

### Issue delivery

The workflow that develops and delivers an issue's intended change. Its tasks are flat; the table is not an executable sequence. Author is optional. Independent work may proceed concurrently where the dependency and authorization rules permit it.

| Task | Prerequisites | Result |
| --- | --- | --- |
| Author | Authoring requested | Authored requirements |
| Implementation | Requirements | A revision of the change |
| Hardening | A revision | A Hardening result for that revision, which may first produce a new revision |
| Integration | A current Hardening result for revision R; target state T | An integration result for R on T, which may first sync to a new revision |
| Security | A current integration result for R on T | A Security result for R, T and the policy |
| Land | Current Hardening, Integration and Security results for the same R and T; authorization | R landed on the target at M |
| Completion | The Land result | Work-item completion |

When sync produces a new revision, the earlier Hardening result stays bound to the old one. Land's prerequisite is then unmet and Hardening runs for the new revision; no task moves backwards. Concurrency does not weaken existing verification, revision, target or policy requirements.

The Developer performs Implementation. Security and Hardening have decoupled actors. The remaining role assignments, the complete dependency graph, branch and join rules, and historical compatibility still need design. This intended model does not describe every historical or installed version.

### Run state

The run's execution condition, distinct from the tasks it performs, its outcome and observed process liveness.

Running, waiting, stopped and ended illustrate conditions; they are not an agreed serialized enumeration. A recorded Running value is not proof that a process is live.

### Outcome

What a run achieved or why it ended. Outcome is distinct from run state and work-item completion.

For example, a Land run may end successfully while its work item still awaits Completion.

### Work-item completion

Fulfillment of the work item's intended outcome under its completion conditions.

A closed issue, landed revision or ended run alone does not establish completion. Do not use status as an interchangeable name for the tasks that may proceed, run state, outcome and work-item completion.

## Observation and uncertainty

### Observation

Evidence collected about work or execution, recording its source, observation time and limits or uncertainty.

Preserve unknown and unavailable evidence as such. An unavailable source is not an empty result. Denied process inspection does not prove a run is not live. Absence of observed activity does not establish that a resource is available.

Recorded run state, observed liveness, test outcome and cleanup coverage are separate facts. Passing tests can coexist with unverified cleanup.

### Reconciliation

Collection and comparison of observations to establish an uncertain action result.

A lost response does not prove that the action failed. Reconciliation does not authorize repeating an action to obtain a clearer result. Preserve conflicting evidence rather than silently selecting a convenient claim.

## Requests, authority and records

### Request

An expression of desired work or action.

A request can convey authorization from an authorized person. Arbitrary request text does not grant authorization.

### Authorization

Permission to perform a specific action within defined scope and conditions.

Work assignment, a role, an observation or possession of a capability does not by itself establish authorization.

### Capability

The technical means to perform an action, such as an available tool, credential or identity. Capability does not establish authorization.

Dash composes requests for its caller; it does not directly control workflow execution. Status-report observes work; it does not manage it.

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

A slot can remain occupied after a run ends while a registered consumer still needs it. Idle observations or work-item completion do not establish release.

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

The accepted distinctions do not yet specify the following contracts:

- Actor, role, identity and account schemas, including how external runtime names map to them.
- Which roles own Hardening, Integration, Security, Land and Completion, and the name of each role.
- A name for the tasks that may proceed now (proposed: ready tasks).
- The capacity unit: roles, tasks or resources such as model sessions, test slots and target writes (proposed: resources).
- Exact run-state and outcome values, run linkage and recovery transitions.
- Task prerequisite and result schemas, attempt budgets per binding, branch/join conditions and repeated-check transitions.
- Resource ownership, registered-consumer identity and release protocols.
- Policy, approval and source acceptance versus landing, installation and activation.
- Observation schemas, source authority, freshness and collection coverage.
- Historical configuration, command and saved-record migration.

Resolve these contracts before implementing dependent changes. Do not fill missing facts or permissions with inferred defaults.
