# Sync

This page describes how the Reviewer integrates a hardened change with its base at merge time: rebasing, conflict resolution, check fixes and their limits. The rules are in [delivery decisions](../decisions/delivery.md).

## Integration

Only the merge stage synchronizes. The Developer and hardening never rebase onto the base. The Reviewer's integration rebases the issue branch onto the fetched base and fixes checks that fail there, in bounded writer sessions in phase `integration`. Candidate-local synchronization and checks may run before the issue's queue turn; the queue orders target mutations.

The pipeline verifies the exact result, pushes it and saves an integration receipt (`state.integration`). That receipt records the original hardened revision and the integrated revision; it does not authorize changed code to merge. Any code change, including a clean rebase or conflict resolution, returns to `review` for fresh hardening and checks. The merge stage then needs Security clearance and required CI on that exact code/input revision.

A head that moved outside integration also returns to `review`. A target that moves during Security invalidates clearance; the next turn synchronizes and obtains fresh required reviews rather than merging stale work.

## Conflicts

A rebase that stops on conflicts stays in the checkout for a resolver session. The resolver stages the files it resolved and returns; it doesn't continue the rebase or push. The `finish-sync` op continues the rebase, returns any later conflict to the next resolver session, and checks the completed rebase before the guarded push.

A binary file, such as a visual-test baseline, can't hold a merged result, so the resolver keeps the target's bytes for it. When the branch meant to change that file and a later check detects the mismatch, a check-fix session regenerates only that file from the resolved code. Hardening reviews the result.

A base that removed a submodule leaves the submodule's folder behind after the rebase, as untracked files. Once the rebase finishes, the pipeline removes that folder when its repository stays in the checkout's own `modules/` folder, so its commits and stashes survive. The folder must hold no nested repository and nothing uncommitted, untracked or ignored. Any other folder stays, and the finish check rejects the rebase.

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
