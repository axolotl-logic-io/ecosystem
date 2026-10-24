# Sync

This page describes Sync: the task that brings a revision onto its target. It covers when Sync runs, conflict resolution, its limits and how to recover from a Sync stop. The rules are `sync-is-a-task` and `two-buddies` in [buddies and tasks](../decisions/buddies-and-tasks.md).

## The Sync task

Sync takes revision R and an exact target commit T that R doesn't contain. It produces R′, a new revision that contains T, or it stops with its work kept. Hippy, the Developer, runs it. The development account pushes the branch, and the landing account records the run's attempt and result as [task results](task-results.md).

Sync only rebases and resolves conflicts. A check that needs a code fix isn't Sync's work: it returns to Hardening, which produces a new revision.

R′ is a new revision, so every later task's result for R stops being current. Hardening, Integration and Security for R′ start as missing, and the issue goes back to `review` for fresh Hardening.

## When Sync runs

No stage synchronizes on its own. A stage that finds R doesn't contain the current target ends `wait` with a request, and the caller starts the Sync task job:

- **Review** reads the chain before Hardening. If R misses the target, it requests Sync first, so no session hardens work that Sync would replace.
- **Merge** never rebases. A target that moved after Hardening sends the work back to review, which requests Sync. A merge refused as `behind` or `conflict` requests Sync directly.
- **Integration** routes a target that moved, or an R that misses T, to `sync-needed` and requests Sync of the fresh binding.

The request carries the full binding, so the caller relays it unchanged:

```bash
node "$ISSUE_PIPELINE_ROOT/caller-jobs.mjs" start --run RUN_DIR --config CONFIG \
  --issue ISSUE --branch BRANCH --lane LANE --stage STAGE \
  --task sync --binding 'BINDING_JSON'
```

- `STAGE`: the stage the request was made at, `review` or `merge`.
- `BINDING_JSON`: the `request.binding` the job printed, exactly.

The job refuses a binding for another issue, repository, task or target branch before it claims or writes anything.

## What a Sync run does

```
sync-task            check R and T fresh, record the attempt, rebase R onto exactly T
  └─ clean           push R′ (development account), check the branch holds R′ ⊇ T, record passed
  └─ stopped         keep the rebase for Hippy's resolver session
sync-task-finish     continue the staged resolution, or retain it, or save it and record failed
sync-task-reconcile  settle an interrupted run by reading the branch and the checkout
```

Before any writer effect, each op reads these afresh and refuses if any fails:

- the binding is this issue's Sync binding, with today's trusted inputs and policy;
- no Land attempt is armed or uncertain, and saved state still lets the code be written;
- T is on the configured target, and both the checkout and the branch are at R.

Success is checked on the branch itself. The branch must hold exactly the pushed head, and that head must contain the exact requested T. A rebase that keeps an older ancestor of the target isn't proof.

A passed Sync saves R′ as the issue's head, voids Hardening and returns the issue to `review`. A binding whose Sync already passed never reruns.

## Conflicts

A rebase that stops on conflicts stays in the checkout for a resolver session. The resolver is Hippy in a fresh Developer session of phase `sync`, with the prompt page `sync.md`. It stages the files it resolved and returns; it doesn't continue the rebase or push. The `sync-task-finish` op continues the rebase, returns any later conflict to the next resolver session, and checks the completed rebase before the push.

A binary file, such as a visual-test baseline, can't hold a merged result, so the resolver keeps the target's bytes for it. When the branch meant to change that file and a check later fails on it, fresh Hardening regenerates it.

A base that removed a submodule leaves the submodule's folder behind after the rebase, as untracked files. Once the rebase finishes, the pipeline renames that folder, whole, into a new `retired-submodules-*` folder in the issue's `recovery/` folder, so the checkout is clean and nothing is deleted.

- Each resolver session that ends, however it ends, counts as one of `maxConflictFixes` (default 2) attempts, saved at once.
- A later conflict on the same rebase goes to the next resolver with the current paths and the next attempt number.
- A `cannot-fix` reply, or a resolver session that fails, ends the run as `failed` with the work saved in recovery. A retry is a new run.
- At the limit, `sync-task-finish` keeps the stopped pick and the issue stops with `agent:stopped-conflict`, naming the pick, the paths and where its evidence is kept.

A changed gitlink (submodule pointer) in a conflict stops with its full stage SHAs and the unresolved evidence kept. Resolvers never choose submodule revisions.

## Limits

| Setting | Default | Bounds | Stop |
|---|---|---|---|
| `maxSyncs` | 3 | Sync runs of one issue without landing | `agent:stopped-sync-limit`: the base kept moving |
| `maxConflictFixes` | 2 | Resolver sessions | `agent:stopped-conflict` |
| Task attempts | 3 | Sync runs per binding (R, T, inputs, policy) | `agent:stopped-error` until a person reconciles |

A new binding, such as a new target commit, starts a new attempt budget. The budget lives in the records on GitHub, so it survives caller restarts and new run folders.

## Evidence kept on failure

Before any abort, reset or clean, synchronization saves the staged and working-tree patches and a verified Git bundle of current, local-branch and pre-rebase history.

An unresolved index also saves `conflict-stages.json`: path, stage number, mode and full object ID for each entry. The original checkout, unresolved index and working files are then kept, and destructive cleanup is refused. See [checkouts](checkouts.md) for where evidence lives.

## Interrupted runs

An interrupted run leaves its attempt unsettled. The next Sync job for the same binding reconciles it with `sync-task-reconcile`, which only reads, before any new attempt:

| The branch | The checkout | Result |
|---|---|---|
| A new head H that contains T | At H | `passed`, with R′ = H |
| Still at R | Rebased past R | `failed`: the push never landed; the rebased work is saved in recovery |
| Still at R | At R, no synchronization | `failed`: the run ended before any effect |
| Anything | A stopped rebase | Held: finish, retain or recover it by hand |
| Anything else | Anything else | Held |

Reconciliation never repeats the push or the rebase.

## Recover from a Sync stop

1. Stop dispatching the issue.
2. Read the stop comment. It names the paths and where the evidence is kept.
3. Keep the checkout, `conflict-stages.json`, the bundle and the patches until the work is safe.
4. For `sync-limit`, find out why the base keeps moving before the issue lands; landing fewer issues at once or holding the base briefly helps. Don't raise `maxSyncs` as a reflex.
5. For `conflict`, resolve the conflict through ordinary reviewed work on the same branch, or recover the kept checkout explicitly. Then restart the issue at its saved stage, on the same issue, branch and lane, and relay the Sync request it prints. Nothing applies saved evidence automatically.

## Before #186

Until #186, the merge stage synchronized as part of the Reviewer's writable integration, and fixed failing checks in the same sessions. That path retired: `roles/merge/sync.ts`, `roles/merge/integration.ts` and the `integration` prompt page are gone, and no role may call the `sync-base` or `finish-sync` ops. A saved `integration` receipt from before then stays readable as history.
