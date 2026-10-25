# Task results

A task result records what one action found for one exact binding. Tasks read these records fresh when they match signals, check prerequisites and perform controlled effects. A result is not a workflow stage, a checkout checkpoint or permission to replay its action. See [buddies and tasks](../decisions/buddies-and-tasks.md) and the [domain runtime contract](../domain-runtime-contract.md).

## Record authority

Each attempt and result is a separate append-only hidden issue comment under `agent-pipeline:task-result`. Only the landing account writes it, including results for Developer work. Readers verify current authorship and editor provenance. A recorded role name is not authentication.

Current records use version 2. They name the binding, action run, producing buddy run and accepted cause. A stale work-state save cannot erase them. Work state uses its own version 4 schema; its checkout checkpoints never substitute for task results.

Version 1 task records and earlier saved states remain history under their original bytes and names. They do not become current passes. Unsettled historical Land and refused Security subjects still fence work. Unknown versions, malformed records or conflicting provenance hold the item rather than selecting a permissive subset.

## Binding

Every field must match for a revision result to be current. Missing fields never match.

| Field | Meaning |
|---|---|
| `workItem` | An object containing the configured `repo` and positive issue `number` |
| `task` | A canonical task ID: `author`, `implement`, `harden`, `sync`, `integrate`, `review-security`, `land`, `complete` or `refactor-safely` |
| `revision` | The full 40-hex code commit, 64-hex trusted-inputs hash and 64-hex policy digest |
| `requirements` | Instead of `revision`, the `sha256:` requirements digest for Author or Implement |
| `target` | The configured literal target `branch` and its full commit |

The requirements digest covers the trusted issue title, body and qualified collaborator comments. A label, pipeline comment or untrusted visitor comment does not change it. Unreadable collaborator evidence holds work; it is not silently dropped.

The policy digest binds effective checking commands, practice files, lockfile and migration settings, CI requirements, command limits, repository permissions and shared model-session capacity. Buddy authorization is checked separately against the trusted buddy and repository files. A result cannot supply a missing buddy grant.

## Attempt and result fields

An attempt contains `version: 2`, `kind: "attempt"`, `binding`, `run`, `buddyRun` and `cause`. It is appended before the task's substantive work. Effects that own their settlement, such as Sync and Land, use their guarded operation to open and settle the attempt.

A result contains the same identity fields, `kind: "result"`, a `verdict` and a `receipt`:

- `run.id` identifies the action. `run.previous` links its predecessor or is null.
- `buddyRun` identifies the buddy activation that produced the action.
- `cause.signal` identifies its accepted signal. `cause.recordId` retains the corresponding authoritative record when present.
- `verdict` is `passed`, `failed`, `refused` or `unknown`; it is distinct from process exit and local action outcome.
- `receipt.summary` records the observation in at most 300 characters.
- `receipt.produced.code` optionally identifies new code produced by a writer.
- `receipt.evidence` optionally records structured evidence, such as deterministic check exits.

A result must match its attempt's binding, run, buddy and cause. A run has at most one determined verdict. Read-only reconciliation may follow an unknown observation with a determined verdict for that original attempt; it does not create a replacement action or effect.

## Current results

| Task | What its pass attests |
|---|---|
| Implement | The current requirements and the code it produced |
| Sync | Input revision R on exact target T, producing R′ containing T |
| Harden | The revision it attests, including code it produced, on exact T |
| Integrate | Exact revision R, trusted inputs and policy on exact T |
| Review Security | The independently reviewed exact candidate on exact T |
| Land | The confirmed own fast-forward of that authorized candidate |
| Complete | The original authenticated Land subject and completion proof, not a later target tip |

Implement remains current while its trusted requirements do; a target movement needs Sync and fresh Harden, not another Implement. An authenticated Implement attempt spends its start regardless of verdict or target movement. Newly edited requirements need a newly accepted start.

A Sync output or code change invalidates downstream results for the old code. A target or policy change likewise cannot reuse a mismatched revision result. A Security refusal fences the same code and trusted-inputs subject across target or policy changes; changing those fields cannot evade rejection.

## Holds and replay prevention

A missing binding may become ready only with a supported qualified cause, task prerequisites, buddy authorization and ownership. A passed binding waits and never reruns. A failed or refused binding holds; neither is retried automatically. An unsettled binding uses its task's read-only recovery when authorized, or holds for explicit reconciliation.

Records retain a three-attempt ceiling per task and binding as an additional validation constraint. That ceiling is not a retry mechanism. Restarting a buddy, removing a label, ending a process, changing a target or linking `run.previous` grants no unsupported continuation.

Readers hold when a record has the wrong work item, unknown version, bad authorship, malformed identity, reused run ID, invalid predecessor, unmatched attempt or conflicting determined verdict. Only a current pass can satisfy a prerequisite; even a pass grants no authority outside its exact scope.

## Guarded operations

| Operation | Responsibility |
|---|---|
| `task-attempt` | Check fresh prerequisites and authority, then append the bound attempt |
| `task-result` | Append the original action's authenticated settlement |
| `checkpoint-action` | Preserve durable action progress in canonical work state, not grant a task pass |
| Task-specific effects and `*-reconcile` operations | Record their own bound attempt/result or settle that original attempt without replay |

Every operation requires its execution binding and a freshly verified buddy envelope. Substantive effects recheck source qualification, stop evidence and write fences at the controlled mutation. Evidence-only finalization can survive source loss or a stop only under current recording authorization and ownership; it cannot hide a code, PR or target mutation.

Recording appends once and confirms by reading. A lost response remains uncertain. The next authorized reconciliation reads for the original write; it never repeats a possibly accepted POST. Local action observations help find evidence but do not replace this protocol.
