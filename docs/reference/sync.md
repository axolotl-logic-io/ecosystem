# Sync

This page describes how the Reviewer integrates a hardened change with its base at merge time: rebasing, conflict resolution, check fixes and their limits. The rules are in [delivery decisions](../decisions/delivery.md).

## Integration

Only the merge stage synchronizes. The Developer and hardening never rebase onto the base. The Reviewer's integration rebases the issue branch onto the fetched base and fixes checks that fail there, in bounded writer sessions in phase `integration`. Candidate-local synchronization and checks may run before the issue's queue turn; the queue orders target mutations.

The pipeline verifies the exact result, pushes it and saves an integration receipt (`state.integration`). That receipt records the original hardened revision and the integrated revision; it does not authorize changed code to merge. Any code change, including a clean rebase or conflict resolution, returns to `review` for fresh hardening and checks. The merge stage then needs Security clearance and required CI on that exact code/input revision.

A head that moved outside integration also returns to `review`. A target that moves during Security invalidates clearance; the next turn synchronizes and obtains fresh required reviews rather than merging stale work.

## Conflicts

A rebase that stops on conflicts stays in the checkout for a resolver session. The resolver stages the files it resolved and returns; it doesn't continue the rebase or push. The `finish-sync` op continues the rebase, returns any later conflict to the next resolver session, and checks the completed rebase before the guarded push.

A binary file, such as a visual-test baseline, can't hold a merged result, so the resolver keeps the target's bytes for it. When the branch meant to change that file and a later check detects the mismatch, a check-fix session regenerates only that file from the resolved code. Hardening reviews the result.

A base that removed a submodule leaves the submodule's folder behind after the rebase, as untracked files. Once the rebase finishes, the pipeline renames that folder, whole, into a new `retired-submodules-*` folder in the issue's `recovery/` folder, so the checkout is clean and nothing is deleted. A path through a symlink isn't moved. A folder on another filesystem from `recovery/` isn't copied, because a copy may lose data; it stays, and the finish check rejects the rebase.

- Each resolver session that ends, however it ends, counts as one of `maxConflictFixes` (default 2) attempts, saved at once. A transient failure doesn't count.
- A later conflict on the same rebase goes to the next resolver with the current paths and the next attempt number. The earlier staged resolution isn't treated as rejected.
- A `cannot-fix` reply can complete only through the normal finish and push checks. An explicit abort never pushes.
- At the limit, `finish-sync` keeps the stopped pick and stops with `agent:stopped-conflict`, naming the pick, the paths and where its evidence is kept.

A changed gitlink (submodule pointer) in a conflict stops with its full stage SHAs and the unresolved evidence kept. Resolvers never choose submodule revisions.

## Limits

| Setting | Default | Bounds | Stop |
|---|---|---|---|
| `maxSyncs` | 3 | Integrations of one issue without merging | `agent:stopped-sync-limit`: the base kept moving |
| `maxConflictFixes` | 2 | Resolver sessions | `agent:stopped-conflict` |
| `maxCiFixes` | 2 | Check-fix sessions | `agent:stopped-check-fixes` |

## Evidence kept on failure

Before any abort, reset or clean, synchronization saves the staged and working-tree patches and a verified Git bundle of current, local-branch and pre-rebase history.

An unresolved index also saves `conflict-stages.json`: path, stage number, mode and full object ID for each entry. The original checkout, unresolved index and working files are then kept, and destructive cleanup is refused. See [checkouts](checkouts.md) for where evidence lives.

## Recover from a sync stop

1. Stop dispatching the issue.
2. Read the stop comment. It names the paths and where the evidence is kept.
3. Keep the checkout, `conflict-stages.json`, the bundle and the patches until the work is safe.
4. For `sync-limit`, find out why the base keeps moving before the issue's turn ends; merging fewer issues at once or holding the base briefly helps. Don't raise `maxSyncs` as a reflex.
5. For `conflict`, resolve the conflict through ordinary reviewed work on the same branch, or recover the kept checkout explicitly. Then restart `merge` on the same issue, branch and lane. Nothing applies saved evidence automatically.

## The Sync task (inactive)

[#184](https://github.com/axolotl-logic-io/ecosystem/issues/184) adds Sync as its own task, following `sync-is-a-task` in [buddies and tasks](../decisions/buddies-and-tasks.md). Nothing installed uses it yet. The merge stage above keeps synchronizing until [#186](https://github.com/axolotl-logic-io/ecosystem/issues/186) activates the split.

A Sync run takes revision R and an exact target commit T that R doesn't contain. It produces R′, a new revision that contains T, or it stops with its work kept. Hippy's development account pushes the branch. The landing account records the run's attempt and result as [task results](task-results.md).

```
sync-task            check R and T fresh, record the attempt, rebase R onto exactly T
  └─ clean           push R′ (development account), check the branch holds R′ ⊇ T, record passed
  └─ stopped         keep the rebase for a resolver session
sync-task-finish     continue the staged resolution, or retain it, or save it and record failed
sync-task-reconcile  settle an interrupted run by reading the branch and the checkout
```

Before any writer effect, each op reads these afresh and refuses if any fails:

- the binding is this issue's Sync binding, with today's trusted inputs and policy;
- no Land attempt is armed or uncertain, and saved state still lets the code be written;
- T is on the configured target, and both the checkout and the branch are at R.

Success is checked on the branch itself. The branch must hold exactly the pushed head, and that head must contain the exact requested T. A rebase that keeps an older ancestor of the target isn't proof.

R′ is a new revision, so every later task's result for R stops being current. Hardening, Integration and Security for R′ start as missing. A check that needs a code fix isn't Sync's work: it returns to the Developer.

The installed safeguards still apply, because Sync runs the same code. A gitlink conflict is refused with its numbered stages. Text and binary conflicts go to the resolver. A retired submodule's folder moves whole into recovery. Rejected work is saved as a bundle before any cleanup, and an unresolved index is retained, never reset.

An interrupted run leaves its attempt unsettled, and no new attempt starts until `sync-task-reconcile` settles it by reading:

| The branch | The checkout | Result |
|---|---|---|
| A new head H that contains T | At H | `passed`, with R′ = H |
| Still at R | Rebased past R | `failed`: the push never landed; the rebased work is saved in recovery |
| Still at R | At R, no synchronization | `failed`: the run ended before any effect |
| Anything | A stopped rebase | Held: finish, retain or recover it by hand |
| Anything else | Anything else | Held |

Reconciliation never repeats the push or the rebase.
