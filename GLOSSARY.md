# Shared domain glossary

This draft records the domain language Autumn accepted for ecosystem, the Pi dash extension, the status-report skill and the test-suite assessment app. Use one canonical term for each shared concept. Different names remain only when they describe different concepts.

These definitions describe the intended domain. They do not claim that existing code, saved records or installed tools already conform. The [domain alignment inventory](docs/domain-alignment.md) identifies known differences and migration decisions. Historical names there are migration references, not permanent synonyms.

## Actors and responsibilities

### Operator

The human responsible for installation and operational configuration.

An operator can also act as a caller, but these are different responsibilities. Starting a run does not by itself make someone an operator. Dash's agent-execution records are not operators; name that view **Agent runs**.

### Caller

The person or program that selects work, invokes tools and handles their results.

Use caller instead of orchestrator wherever both name this responsibility. A caller may coordinate multiple runs. That coordination does not grant installation, merge or other action authority.

### Assignee

The person or agent explicitly assigned to a work item.

Use assignee rather than owner when the meaning is work assignment. Do not infer assignment from execution or from who must answer a question. Ownership of resources remains a separate concept.

### Executing agent

The agent performing a particular run. It may differ from the work item's assignee.

### Developer

The canonical agent role for developing a change. Use Developer instead of Implementor wherever they name the same role. Implementation is a stage, not the role's name.

A role describes responsibility. It does not establish agent identity, authorization or available capabilities.

## Work and execution

### Work item

An independently tracked intended outcome, separate from its executions. A work item can have dependencies, an assignee and a completion condition. It may require several runs or have no active run.

A plan task and a GitHub issue can represent the same work item, but equivalence requires explicit linkage. Similar titles or bare issue numbers do not establish identity.

### Run

One execution, such as invoking a tool, agent or workflow, with its own identity, start time, state and eventual outcome.

A work item may have several runs. Runs may contain child runs. Ending a run does not necessarily complete its work item. Existing pipeline job and launch records need explicit mapping before their names or identities change.

### Agent run

A run performed by an agent. Use **Agent runs** for dash's agent-execution view; Operators was its historical label. An agent run may participate in a workflow run or operate independently.

### Retry

A new run linked to an earlier run. A retry has a new run identity. This definition does not authorize a retry or establish that repeating an uncertain action is safe.

### Resumption

Continuation of a preserved run with the same run identity.

Starting a fresh run from a checkpoint is not resumption of the original run. Continuing the same session alone also does not establish run resumption. Map existing restart behavior from its actual identity and execution semantics, not its command name.

### Session

An agent's retained conversation and context. One session can support multiple agent runs.

Session identity, run identity and checkpoint identity are not interchangeable.

### Workflow

Work and its dependency rules toward an outcome, not a fixed serial sequence. A workflow can branch, execute independent work concurrently, join results, repeat checks and recover from interruption.

Dependencies and authorization conditions determine what may proceed. A stage list alone does not impose a total execution order. Use Workflow rather than Pipeline for this shared concept; retain old technical names only at explicit compatibility or historical boundaries.

### Prerequisite

A specific result, condition or permission that an action requires before it may proceed. Dependencies identify these prerequisites, not blanket completion of all work with the same stage label.

For example, merging change A requires a passing Security result for the exact version being merged and separate authorization for that target change. Unrelated security work on change B does not block A. If A changes, the earlier result does not satisfy the prerequisite for its new version; retain it as historical evidence. A passing check is evidence, not permission.

### Workflow run

One execution of a workflow. It may contain agent runs and deterministic tool executions. It is not necessarily the entire lifetime of a work item: retries or later work can require additional workflow runs.

Each run retains its own identity. Establish parent–child links from explicit records, not from coincident names, times or a shared issue. Dash's workflow-run and agent-run views currently read different sources and do not establish those links.

### Stage

A named part of a workflow. A stage may use agents or execute deterministically without an agent. Stage names describe responsibilities, not an implicit global synchronization barrier. Do not assume a workflow run has only one active stage when its work can proceed concurrently.

Issue delivery uses the flat stages below. Integration and Security are not phases nested inside an umbrella Merge stage. Define execution dependencies separately from stage names.

### Issue delivery

The workflow that develops and delivers an issue's intended change. Its stage inventory is flat; the table is not an executable sequence. Author is optional. Independent work may proceed concurrently where the dependency and authorization rules permit it.

| Stage | Responsibility |
| --- | --- |
| Author | Clarify requirements when requested. |
| Implementation | Develop the change. |
| Hardening | Improve and verify correctness, design and tests. |
| Integration | Reconcile the change with its target and verify the candidate. |
| Security | Assess the exact candidate under the applicable policy. |
| Merge | Apply the authorized change to the target. |
| Completion | Verify the delivered result and record work-item completion. |

Merge names the target-changing stage, not the surrounding workflow. The Git target mutation is an operation within that stage. Security must assess the exact candidate before its authorized target mutation; Completion verifies the delivered result. Concurrency does not weaken existing verification, candidate, target or policy requirements.

The complete dependency graph, branch/join rules, repeated-check transitions and historical compatibility still need design. This intended model does not describe every historical or installed version.

### Run state

The run's execution condition, distinct from its workflow stage, outcome and observed process liveness.

Running, waiting, stopped and ended illustrate conditions; they are not an agreed serialized enumeration. A recorded Running value is not proof that a process is live.

### Outcome

What a run achieved or why it ended. Outcome is distinct from run state and work-item completion.

For example, a Merge run may end successfully while its work item still awaits Completion.

### Work-item completion

Fulfillment of the work item's intended outcome under its completion conditions.

A closed issue, merged change or ended run alone does not establish completion. Do not use status as an interchangeable name for stage, run state, outcome and work-item completion.

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

Work assignment, an agent role, an observation or possession of a capability does not by itself establish authorization.

### Capability

The technical means to perform an action, such as an available tool or credential. Capability does not establish authorization.

Dash composes requests for its caller; it does not directly control workflow execution. Status-report observes work; it does not manage it.

### Artifact

A durable output, such as a report, patch or test log. Checkpoints and receipts are artifacts with different purposes.

### Checkpoint

A saved progress record used to continue work.

A checkpoint recording that a merge was requested is not a receipt confirming that the merge occurred.

### Receipt

A record confirming that a specific action occurred, bound to its identity and result.

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

- Agent, tool and role identity schemas, including how external runtime names map to them.
- Exact run-state and outcome values, run linkage and recovery transitions.
- Workflow dependency schemas, branch/join conditions and repeated-check transitions; stage names alone do not define them.
- Resource ownership, registered-consumer identity and release protocols.
- Policy, approval and source acceptance versus landing, installation and activation.
- Observation schemas, source authority, freshness and collection coverage.
- Historical configuration, command and saved-record migration.

Resolve these contracts before implementing dependent changes. Do not fill missing facts or permissions with inferred defaults.
