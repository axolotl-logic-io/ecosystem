# Land and Complete

Land moves the configured target to an authorized revision. Complete records work-item completion after the item's own Land. These are independent Gatekeeper tasks, not a `merge` stage or a caller-owned sequence. A Git merge is a separate concept; the supported Land effect is an immutable-head fast-forward. See [buddies and tasks](../decisions/buddies-and-tasks.md) and the [domain runtime contract](../domain-runtime-contract.md).

## Land prerequisites

Land requires current Harden, Integrate and independent Review Security passes for the same revision R, trusted inputs, policy and exact target T. R must strictly descend from T. A current Security refusal fences its code and trusted-inputs subject even if the target or policy changes.

A pass is evidence, not permission. The trusted repository must explicitly grant `permissions.land`, and the Gatekeeper buddy must have the correct scope, responsibility, account and lander profile. Current ownership, source qualification, stop evidence and write fences still apply at the actual mutation. Required CI must attest the exact head; absent, pending, failed or unreadable required evidence cannot authorize Land.

A revision missing T needs [Sync](sync.md) and fresh Harden. Changed code, inputs, target or policy cannot reuse mismatched results. No task runs a repair writer or infers a retry from a failed prerequisite. All configured task loops remain active; their individual prerequisites decide what may proceed.

## The target's integration turn

A target-write reservation serializes participating Lands for one repository and literal base branch. Land takes this integration turn before recording its attempt. If it cannot acquire the turn, it spends no attempt and performs no approval or target mutation.

The turn uses authenticated coordination records and create-only epoch refs. Issue execution is still required; a turn grants no issue authority. An unsettled Land keeps the turn. Process exit, lease expiry or deletion of a local run directory does not release it. Lost coordination writes retain their uncertainty records and hold for reconciliation.

The turn excludes only participants in this protocol. Outside accounts can still move the target. Fresh target reads and the exact old-object lease must reject that movement; the reservation is not an atomic lock on GitHub itself.

## Fast-forward effect

The guarded `land-task` operation checks the exact binding and prerequisites again. The authenticated version 2 attempt is the original Land intent; it precedes the target effect and retains its action, buddy and cause. A later observation cannot invent that intent.

The landing account pushes the full immutable commit R to the configured repository's literal `refs/heads/BASE`, using an explicit lease for old object T. The runtime verifies strict T-to-R ancestry and the push destination. The lease is compare-and-swap, not permission to replace unrelated work. The PR's body, default branch or alternate remote never chooses the target.

There is no REST-merge fallback, alternate push, admin bypass or automatic retry. A successful acknowledgement is response evidence. Land passes only after a fresh read finds the target at exactly R. An unchanged target after a refused push fails. Contradictory or unreadable evidence remains unknown and retains the turn.

The passed receipt preserves R, pre-Land T, policy and authorization provenance. Target advancement after this Land is not substituted for its original subject.

## After the Land

Complete binds the original passed Land's revision, policy and pre-Land target. It requires the item's own authenticated Land proof, current trusted inputs and fresh ancestry showing that the target still contains R. It does not bind a later target tip as a new candidate or adopt an unrelated external merge.

The `complete-task` operation closes the issue through the landing account and confirms the issue's state. It does not land code, rerun Integrate, request Security or repair missing pre-Land proof. Runtime checkout and reservation cleanup remains separate and requires every consumer to be accounted for. A Land success alone is not work-item completion.

No suite, writer or Security session runs after Land to obtain missing permission. A changed policy after Land neither creates a retrospective clearance nor requires a new check of already-landed code. Missing own proof holds for explicit reconciliation; landed truth is not erased.

## Uncertain effects

Read-only recovery settles the original attempt, with its original identity and binding. A new local reconciling action is not a new substantive attempt.

| Operation | Evidence | Settlement |
|---|---|---|
| `land-reconcile` | Exact target at R under the original Land intent | Passed |
| `land-reconcile` | Exact target still at pre-Land T | Failed; no Land observed |
| `land-reconcile` | Another or unreadable target | Unknown; retain the turn |
| `complete-reconcile` | The issue reads closed under the original Complete attempt | Passed |
| `complete-reconcile` | The issue reads open | Failed; no completion observed |
| `complete-reconcile` | Unreadable or contradictory evidence | Hold |

Neither operation repeats a push or issue close. Current buddy recording authorization and ownership remain required. A lost response is not permission to resend a possibly accepted write.

To investigate uncertainty, stop new dispatch for the affected issue and preserve its attempts, results, checkpoints, coordination records, checkout, consumers and original proof. Read the actual remote effects. Do not erase intent, clear a Security rejection, release another invocation's turn or restart an old stage. An open PR alone does not establish that a target mutation never happened.
