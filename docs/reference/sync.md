# Sync

Sync brings revision R onto an exact target commit T that R does not contain. The Developer task owns matching, prerequisites, rebase effects and recovery. A configured buddy delivers authenticated result signals to it; no saved stage or caller launches a Sync job. See [buddies and tasks](../decisions/buddies-and-tasks.md) and the [domain runtime contract](../domain-runtime-contract.md).

## Prerequisites and output

Sync requires a passed Implement for the current requirements, a current revision and a target that revision does not contain. It can run before Harden; there is no reason to harden code that Sync will replace. An existing Land attempt or incompatible work state prevents code writes.

A passed Sync produces R′ containing the exact requested T. R′ is new code. Harden must attest R′ before Integrate and Review Security can authorize it. Earlier results remain historical; Sync does not copy their permission onto its output or move a global workflow cursor.

A revision that already contains T needs no Sync. A passed binding does not rerun. A changed target is a different binding, not permission to replay an uncertain rebase or push. Retired `maxSyncs` and `maxConflictFixes` controls do not authorize retries.

## Effects

The action uses these guarded operations:

| Operation | Responsibility |
|---|---|
| `sync-task` | Open the action's Sync attempt, check R and T, and rebase the action checkout onto exactly T |
| `sync-task-finish` | Continue one staged conflict resolution, retain the conflict, or preserve and reject it |
| `sync-reconcile` | Settle the original interrupted attempt from retained branch and checkout evidence without repeating a rebase or push |

The development account pushes code. The landing account records authenticated attempts and results. Before controlled mutations, guards recheck buddy authorization, ownership, the action's source, current prerequisites, write authority and stop evidence. Unknown authority holds work rather than selecting an older permissive state.

A successful push must leave the remote work branch at the exact local head, and that new head must contain T. A successful Git command alone is not proof. A moved or unreadable branch leaves the effect unknown for reconciliation.

## Conflicts

A text conflict stays in the action checkout for one fresh Developer resolver session, using phase `sync` and the installed `sync.md` prompt. The resolver stages its resolution; the guarded finish operation continues the rebase and performs any push. A remaining conflict is retained, not sent through an automatic session loop.

A session failure retains the conflict. A `cannot-fix` reply preserves recovery evidence before reset and records failure. Neither outcome grants another attempt. A changed submodule pointer is not a text resolution: synchronization keeps its unresolved evidence rather than choosing a submodule revision.

When the target removed a submodule, synchronization preserves its leftover folder under the issue's recovery directory instead of deleting it. A binary conflict keeps the target's bytes; a needed code or baseline repair belongs to fresh Harden, not repeated Sync.

## Retained evidence

Recovery preserves staged and working-tree patches and verified Git bundles before destructive checkout cleanup. An unresolved index also records paths, stages, modes and full object IDs in `conflict-stages.json`. A stopped rebase or uncertain checkpoint retains the original checkout. Issue ownership and resource claims remain held when safe release cannot be proved. See [checkout preservation](checkouts.md).

A process exit, expired lease, removed label or new buddy activation does not release these claims. Local run observations describe the work; they do not replace authenticated ownership or grant continuation.

## Reconciliation

Read-only effect reconciliation settles the original attempt rather than opening a fresh attempt. It may preserve local recovery evidence and update settlement records under current recording authority. It never repeats a credentialed push or rebase.

| Remote work branch | Retained checkout | Result |
|---|---|---|
| New head H containing T | At H | Passed, with R′ = H |
| Still at R | Rebased past R with synchronization evidence | Failed; preserve the unpushed work |
| Still at R | At R with no synchronization | Failed; no effect observed |
| Any head | Stopped rebase | Held for explicit recovery |
| Contradictory or unreadable evidence | Any state | Held |

To recover retained work, first stop new dispatch for the affected issue and inspect its authenticated attempt, checkpoint, ownership and retained paths. Preserve the checkout, conflict stages, bundles and patches until an authorized recovery establishes what happened. Do not erase records, raise retired counters or restart an old stage. Unsupported retry and continuation remain unsupported.

## Historical behavior

The old merge-stage synchronization and later caller-launched Sync jobs are retired. Their records and recovery files remain historical evidence. No adapter turns an old stage request, assignment or integration receipt into a current Sync grant.
