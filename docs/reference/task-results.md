# Task results

A task result records what one buddy run found for one exact binding. Sync, read-only Integration and Land consume these results ([#180](https://github.com/axolotl-logic-io/ecosystem/issues/180)). This page is the contract that [#183](https://github.com/axolotl-logic-io/ecosystem/issues/183) adds.

[#186](https://github.com/axolotl-logic-io/ecosystem/issues/186) activated the records. Implementation and every task after it record them ([#118](https://github.com/axolotl-logic-io/ecosystem/issues/118) added Implementation), and every task that depends on another reads them fresh.

The rules come from these decisions in [buddies and tasks](../decisions/buddies-and-tasks.md): `bindings-and-ready-tasks`, `requirements-bindings`, `runs-and-retries`, `no-repeated-checks`, `observation-sources` and `additive-record-versions`.

## Where results live

Each record is its own hidden issue comment, appended and never edited. Only the landing account (Lawd, `mergeAccount`) writes them, even for a task that Hippy runs. The development account never records a result.

```
<!-- agent-pipeline:task-result
{"version":1,"kind":"attempt",...}
-->
```

Results don't go into saved state. Saved state stays at version 2, and its bytes don't change. This keeps three guarantees simple:

- A `save-state` or `release` call edits only the state comment, so a stale snapshot can't erase a result.
- Old state never gains fields it didn't have, so nothing is read as authority that wasn't recorded as authority.
- No historical field is a result. `state.integration`, `verifiedSha` and `hardened` stay as history. A missing Integration result never becomes a pass because of them.

## Binding

A binding names exactly what a result is about. Every part must match for the result to be current. A missing part never matches.

| Field | Meaning |
|---|---|
| `repo` | The configured repository, such as `o/r`. |
| `workItem` | The issue number. |
| `task` | One of `Author`, `Implementation`, `Hardening`, `Sync`, `Integration`, `Security`, `Land` or `Completion`. |
| `revision` | The full code commit (40 hex), the trusted-input revision (64 hex) and the policy digest (64 hex). |
| `requirements` | Instead of `revision`, for `Author` and `Implementation` only: `sha256:` and the 64-hex trusted-inputs hash. |
| `target` | The literal target `branch` and its full `commit`. |

```json
{
  "repo": "o/r",
  "workItem": 7,
  "task": "Integration",
  "revision": {
    "code": "3f1c…40 hex",
    "inputs": "9ab2…64 hex",
    "policy": "51de…64 hex"
  },
  "target": { "branch": "integration", "commit": "c313…40 hex" }
}
```

The target branch must be the configured base branch. A binding for any other repository, work item or branch holds.

The **requirements digest** covers the issue's title, body and trusted collaborator comments, the same bytes as the revision's `inputs`. That's what the Developer receives as its requirements, and an accepted Gherkin comment is bound to the same hash. A label or a pipeline comment never changes it.

```json
{ "repo": "o/r", "workItem": 7, "task": "Implementation",
  "requirements": "sha256:1083…64 hex",
  "target": { "branch": "integration", "commit": "7ec8…40 hex" } }
```

## Records

An **attempt** is recorded before a run does its task's work. It names the binding and the run:

```json
{ "version": 1, "kind": "attempt", "binding": { … },
  "run": { "id": "UUID", "previous": "UUID or null" } }
```

A **result** names the same binding and run, the verdict and a receipt:

```json
{ "version": 1, "kind": "result", "binding": { … }, "run": { "id": "UUID" },
  "verdict": "passed", "receipt": { "summary": "…", "produced": { "code": "…" } } }
```

- `verdict` is `passed`, `failed`, `refused` or `unknown`. It belongs to the result, not to how the run ended.
- `receipt.summary` says what the run observed, in at most 300 characters.
- `receipt.produced.code` is optional. A writer task such as Sync names the new revision it produced.
- `receipt.evidence` is optional JSON, such as the check exits a task observed.

## Runs and retries

Every run has a new run identity. A retry never reuses an old one.

- `run.previous` links a retry to the run before it. Within one binding, each attempt after the first must name the latest attempt as `previous`.
- A first attempt for a binding may name any earlier attempt of the same task, such as the run on the revision before a Sync, or `null`.
- A result must belong to an attempt with the identical binding. A run records at most one determined verdict. An `unknown` verdict may later be followed by one determined verdict for the same run, when a read-only reconciliation establishes it.

Attempts are counted per task and binding. Each task allows three attempts per binding. The count lives in the records on GitHub, so it survives caller restarts, new run folders and lifted stops. Lifting a stop resets saved state's round counts, but it can't replenish an attempt budget. A new binding, such as a new revision, target commit or policy, starts a new budget.

## Status of a binding

The `task-result` op reads every record on the issue and reports one status for the requested binding:

| Status | Meaning | What may happen next |
|---|---|---|
| `passed` | A passed result is current. | Nothing reruns for this binding (`no-repeated-checks`). |
| `refused` | A refused result is current. | Nothing reruns for this binding. |
| `unknown` | The latest attempt has no determined verdict. | Reconcile by reading; never repeat the action. |
| `missing` | No current result, and attempts remain. | A new attempt may start. |
| `exhausted` | The attempt budget is spent. | Stop for a person. |
| `held` | The records can't be trusted as read. | Stop for reconciliation. |

A Security refusal also covers the same code and trusted inputs under any target or policy. An unchanged rejected subject stays rejected, as `security-clearance.ts` already rules for saved state.

The records hold when any of these is true:

- a record is malformed, has an unknown version, or isn't for this repository and work item;
- a record wasn't written and last edited by the landing account;
- a run identity is reused, or a retry doesn't link to the latest attempt;
- a result has no matching attempt, or a run has conflicting verdicts.

Only `passed` can grant authority, and only for the exact binding.

## Who records what

The job's recorder, the landing-account process, writes every record. The run that does a task never does, even when Hippy performs it.

| Task | Recorded by | Binding's revision | When |
|---|---|---|---|
| Implementation | The implement job | None: the requirements the session worked from, on the target read fresh | Attempt and result together, after the Developer's push, before saved state moves to review |
| Sync | The Sync task job's ops | R, the revision synced | The attempt before the rebase, the result after the branch check |
| Hardening | The review job | The hardened revision, after Hardening's own commits | Attempt and result together, after verification, before the checkpoint is saved |
| Integration | The Integration task job's ops | R, the revision checked | The attempt before the checks, the result after |
| Security | The merge job | The candidate | The attempt before the session, the verdict after |
| Land | The `merge` op | The candidate | The attempt before the first PR write, the result once the own Land is confirmed |

**Implementation binds the requirements, and names the revision it pushed** in `receipt.produced.code`. Every Implementation run binds this way, not only the first, so a return after edited requirements has a new binding and a new budget. If the trusted inputs changed during the session, the job records nothing, and review sends the work back to its requirements owner.

**An Implementation result stays current while the requirements do.** Hardening needs a passed Implementation result for today's requirements digest on the configured branch. The target *commit* isn't compared. A moved target needs Sync and fresh Hardening (`sync-is-a-task`), not a new Implementation. Editing the requirements stales the result, so the work goes back to Implementation ([#172](https://github.com/axolotl-logic-io/ecosystem/issues/172)), or to Author first when the issue used Author. Work with no current Implementation result, such as a branch pushed before #118, goes back to implement before any Hardening session.

```
requirements edited after Hardening
  merge  → back to implement        (requirements owner)
  implement → Implementation result for the new digest, naming R2
  review → Hardening of R2          (the old Hardening result stays as history)
```

**Hardening binds the revision it produced.** Integration consumes "a passed Hardening for exactly R on T", and Hardening's session commits fixes, so the result names the revision Hardening checkpointed. Hardening's budget stays the review stage's own limits (`maxCiFixes`). A hardened checkpoint saved before #186 has no result and isn't one: the work returns to review for fresh Hardening.

The other tasks bind the revision they were given. A Sync result names its R and the R′ it produced (`receipt.produced.code`).

Roles find the next ready task with the read-only `task-readiness` op. It reads R, T, whether R contains T, whether an Implementation result is current, and the statuses of the chain's tasks for (R, T). It names the first task without a current pass, with its binding, or a hold. Implementation comes first, then Sync when R misses T, then Hardening, Integration, Security and Land. A stage job that needs a task prints that task and binding as its `request`, and the caller relays it. A buddy could ask the same question later.

## Ops

| Op | Account | Effect |
|---|---|---|
| `task-result` | landing (read) | None. Returns the status above, and `latest`: the binding's latest run, which a retry names as `previous`. |
| `task-readiness` | landing (read) | None. Returns R, T, whether R contains T, the revision the current Implementation result produced (`implemented`, or null), and the next ready task with its binding, or a hold. |
| `record-task-attempt` | landing | Appends an attempt, only when the status is `missing`. |
| `record-task-result` | landing | Appends a result for that run's attempt. |

Each recording op reads the records fresh, appends one comment, then reads them again. It confirms that its own record is there and that the records still don't hold. If the read-back fails, the op reports the record as uncertain and the next caller reconciles by reading.

## Upgrade behaviour

- Saved state version 2, version 1 and coordination records are read exactly as before. Nothing rewrites them.
- An issue with no task-result records has the status `missing` for every binding.
- A future version 2 of these records may add fields. Readers will keep accepting version 1, and a version 1 record's missing parts will never match.
- No key, flag or command is renamed. [#166](https://github.com/axolotl-logic-io/ecosystem/issues/166) owns renames.
