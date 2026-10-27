# Task results

A task result records what one action found for one exact binding. Tasks read these records fresh when they match signals, check prerequisites and perform controlled effects. A result is not a workflow stage, a checkout checkpoint or permission to replay its action. See the [domain runtime contract](../domain-runtime-contract.md).

**Note:** This page describes the source for the five delivery tasks. The installed pipeline still records Harden, Sync, Integrate, Review Security and Complete results until that source is installed.

## Record authority

Each attempt and result is a separate append-only hidden issue comment under `agent-pipeline:task-result`. Only the landing account writes it, including results for Developer work. Readers verify current authorship and editor provenance. A recorded role name is not authentication.

Current records use version 2. They name the binding, action run, producing buddy run and accepted cause. A stale work-state save cannot erase them. Work state uses its own version 4 schema; its checkout checkpoints never substitute for task results.

Readers accept only version 2. A record of any other version, including version 1 records an earlier release wrote, holds the item, as do malformed records or conflicting provenance; the reader never selects a permissive subset. Likewise, saved state other than version 4 holds the item.

## Binding

Every field must match for a revision result to be current. Missing fields never match.

| Field | Meaning |
|---|---|
| `workItem` | An object containing the configured `repo` and positive issue `number` |
| `task` | A canonical task ID: `author`, `implement`, `verify`, `fix`, `land` or `refactor-safely` |
| `revision` | The full 40-hex code commit, 64-hex trusted-inputs hash and 64-hex policy digest, for Verify, Fix, Land and Safe Refactor |
| `requirements` | Instead of `revision`, the `sha256:` requirements digest for Author or Implement |
| `target` | The configured literal target `branch` and its full commit |

For Verify, Fix and Land, the code commit is the head of the item's branch. That branch is the head of the item's pull request (PR), so these tasks bind the PR head.

The requirements digest covers the trusted issue title, body and qualified collaborator comments. A label, pipeline comment or untrusted visitor comment does not change it. Unreadable collaborator evidence holds work; it is not silently dropped.

The policy digest binds effective checking commands, practice files, lockfile and migration settings, CI requirements, command limits, repository permissions and shared model-session capacity. Buddy authorization is checked separately against the trusted buddy and repository files. A result cannot supply a missing buddy grant.

## Attempt and result fields

An attempt contains `version: 2`, `kind: "attempt"`, `binding`, `run`, `buddyRun` and `cause`. It is appended before the task's substantive work. Effects that own their settlement, such as Land, use their guarded operation to open and settle the attempt.

A result contains the same identity fields, `kind: "result"`, a `verdict` and a `receipt`:

- `run.id` identifies the action. `run.previous` links its predecessor or is null.
- `buddyRun` identifies the buddy activation that produced the action.
- `cause.signal` identifies its accepted signal. `cause.recordId` retains the corresponding authoritative record when present. The result repeats its attempt's cause, so a reader can tell what woke a run from the result alone. A cause of `result:N` names the result record `N` that woke it.
- `verdict` is `passed`, `failed`, `refused` or `unknown`; it is distinct from process exit and local action outcome.
- `receipt.summary` records the observation in at most 300 characters.
- `receipt.produced.code` optionally identifies new code: the head a writer, Implement or Fix, pushed, or the merge commit a Land delivered.
- `receipt.evidence` optionally records structured evidence, such as deterministic check exits.

A result must match its attempt's binding, run, buddy and cause. A run has at most one determined verdict. Read-only reconciliation may follow an unknown observation with a determined verdict for that original attempt; it does not create a replacement action or effect.

## Result comments

Each result comment starts with its hidden record, then speaks to the people on the issue in plain sentences. The prose says what happened, which checks ran or what stopped the run, where any pushed work is, and what happens next. The pipeline writes it from the record alone. Before posting, it replaces local paths and IP addresses in the prose and in the record's receipt: its summary and every string in its evidence. Other record fields identify the work, so a local path or address in one of them refuses the record rather than changing it.

Readers parse only the hidden record. The prose is for people and never grants or changes anything. Attempts have no prose, and claims, reservations, polling and checkpoints post nothing, so a comment appears only when a task has a result to report.

## Current results

| Task | What its pass attests |
|---|---|
| Author | Gherkin requirements for the current requirements |
| Implement | The current requirements, and the hardened head it produced |
| Verify | An `APPROVE` review submitted on exactly the bound head |
| Fix | A new head that answers the blocking review and contains the base |
| Land | The PR merged at exactly the bound head, and the issue closed |

Two refusals are part of the normal loop. A refused Verify submitted a `REQUEST_CHANGES` review on exactly the bound head, and it wakes Fix. A refused Land found the approved PR conflicting with its base and marked it a draft, and it wakes Fix too. A Verify result that `failed` means Verify couldn't judge the head.

Implement remains current while its trusted requirements do; a base movement needs Fix, not another Implement. An authenticated Implement attempt spends its start regardless of verdict or target movement. Newly edited requirements need a newly accepted start.

A new head invalidates every review and result for the old head, so Verify becomes ready again. A target or policy change likewise can't reuse a mismatched revision result.

## Verify and Land evidence

Verify and Land put structured evidence in `receipt.evidence`.

A determined Verify result's evidence is `VERIFY_EVIDENCE`:

```json
{
  "review": {"id": 901, "pr": 42, "commit": "HEAD", "state": "CHANGES_REQUESTED"},
  "blocking": 2,
  "nits": 1,
  "security": true
}
```

`review` is the review Verify submitted through the landing account, bound to the binding's code commit `HEAD`. `blocking` and `nits` count its findings. `security` says whether a Security finding was among the blocking ones. The verdict mirrors the review: `passed` for `APPROVED` and `refused` for `CHANGES_REQUESTED`.

A determined Land result's evidence is `LAND_EVIDENCE`, in one of two forms:

```json
{"outcome": "merged", "pr": 42, "head": "HEAD", "mergeCommit": "MERGE", "issueClosed": true}
{"outcome": "conflict", "pr": 42, "head": "HEAD", "base": {"branch": "main", "commit": "BASE"}, "reason": "the PR conflicts with main"}
```

`HEAD` is the checked PR head, `MERGE` the merge commit and `BASE` the base commit Land observed. A `merged` Land is `passed`, and its `receipt.produced.code` is `MERGE`. A `conflict` Land is `refused` and wakes Fix.

## Holds and replay prevention

A missing binding may become ready only with a supported qualified cause, task prerequisites, buddy authorization and ownership. A passed binding waits and never reruns. A failed or refused binding holds; neither is retried automatically, except for the [interrupted Implement run](#interrupted-implement-runs). A refused Verify or Land doesn't rerun for its binding either: Fix answers it with a new head, which is a new binding. An unsettled binding uses its task's read-only recovery when authorized, or holds for explicit reconciliation.

Records retain a three-attempt ceiling per task and binding as an additional validation constraint. That ceiling is not a retry mechanism.

The review loop has its own limit. An issue gets at most three Fix rounds that a refused Verify result caused (`VERIFY_FIX_ROUNDS`). After them, a further request-changes holds the issue for a person. Fix rounds that a person's review or Land's conflict caused don't count. See [the loop limit](review.md#loop-limit). Restarting a buddy, removing a label, ending a process, changing a target or linking `run.previous` grants no unsupported continuation.

Readers hold when a record has the wrong work item, unknown version, bad authorship, malformed identity, reused run ID, invalid predecessor, unmatched attempt or conflicting determined verdict. Only a current pass can satisfy a prerequisite; even a pass grants no authority outside its exact scope.

## Interrupted Implement runs

An Implement run can stop before it records a result, for example when its buddy's machine restarts or the coordination database resets. Its pushed commits are still on the issue's branch.

When a buddy next reads the issue's start, it settles the lost run with `implement-reconcile`. That operation only reads. It records a `failed` result whose `receipt.evidence` is `{ "interrupted": { "branch", "head", "continues" } }`:

- `branch` is the issue's branch.
- `head` is the branch's commit on GitHub now, or null when nothing was pushed.
- `continues` is true when the run's requirements are still the issue's current requirements and they have attempts left under the three-attempt ceiling.

When `continues` is true, that result is the cause of one continuation, `result:N` with `N` its record. The continuation is a new attempt linked to the lost run by `run.previous`. Its checkout starts from the pushed branch, and its writing session is told to finish that work rather than start again. It goes through the same prerequisite, stop and permission checks as any attempt, and the person's original start is checked again too; the start itself is never spent twice.

When `continues` is false, nothing runs on its own. A person starts Implement again when the issue is ready.

## Guarded operations

| Operation | Responsibility |
|---|---|
| `task-attempt` | Check fresh prerequisites and authority, then append the bound attempt |
| `task-result` | Append the original action's authenticated settlement |
| `checkpoint-action` | Preserve durable action progress in canonical work state, not grant a task pass |
| Task-specific effects and `*-reconcile` operations | Record their own bound attempt/result or settle that original attempt without replay; `implement-reconcile` settles a lost Implement run as interrupted |

Every operation requires its execution binding and a freshly verified buddy envelope. Substantive effects recheck source qualification, stop evidence and write fences at the controlled mutation. Evidence-only finalization can survive source loss or a stop only under current recording authorization and ownership; it cannot hide a code, PR or target mutation.

Recording appends once and confirms by reading. A lost response remains uncertain. The next authorized reconciliation reads for the original write; it never repeats a possibly accepted POST. Local action observations help find evidence but do not replace this protocol.
