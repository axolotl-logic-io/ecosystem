# Checkouts

This page describes where the pipeline keeps clones, action checkouts and run files, what an action preserves when it ends, and how test environments and commands are cleaned up. The rules are in [operations decisions](../decisions/operations.md#worktrees-and-branches).

## Layout

Everything lives under `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`). In the paths below:

- `SLUG` is the configured `repo` with `/` replaced by `__`.
- `N` is the issue number.
- `ACTION_ID` is the action run's UUID.
- `KEY` is a session's launch key, such as `developer-1`.

| Path | Holds |
|---|---|
| `clones/SLUG` | The metadata clone, detached at the base branch |
| `work/SLUG/mirror.git` | The bare mirror that action checkouts clone from |
| `work/SLUG/jobs/issue-N-action-ACTION_ID/` | One action's folder; its model sessions run here, and its code checkout is `repo/` |
| `runs/SLUG/lane-slots.json` | Local lane-slot ownership and setup barriers |
| `runs/SLUG/issue-N/actions/ACTION_ID/run.json` | The [action run observation](runtime-runs.md#action-run) |
| `runs/SLUG/issue-N/actions/ACTION_ID/sessions/KEY.jsonl` | Each model session's transcript |
| `runs/SLUG/issue-N/actions/ACTION_ID/context.jsonl` | Bounded measures of each ended session |
| `runs/SLUG/issue-N/dropped/` | Uncommitted-change patches and their manifests |
| `runs/SLUG/issue-N/recovery/` | Verified code bundles and Sync recovery folders |
| `runs/SLUG/issue-N/setup-ACTION_ID.started`, `setup-ACTION_ID.log` | An action's setup start marker and setup log |
| `runs/SLUG/issue-N/integrate-*/` | Integrate's detached check checkout, kept only when it must be retained |
| `runs/SLUG/issue-N/verify-*/` | Check command logs, one folder per checked commit |
| `runs/SLUG/issue-N/pushes.jsonl`, `pushed.json` | The pipeline's own pushes |
| `runs/SLUG/issue-N/coordination-uncertain.json` | The journal of an uncertain coordination write |

The `jobs` folder and the `issue-N-` prefix are installed technical names. Each folder belongs to exactly one action run, so a later action never reuses a retained folder. The action runtime writes no `job.json` or `job.log`.

`clones/`, `work/` and `runs/` are local caches and recovery evidence, not authority. Keep them through upgrades until preserved work is confirmed safe.

## Preservation when an action ends

After it records the task's end, the runtime closes the action's checkout. It keeps the whole checkout, unchanged, when any of these holds:

- A checkpoint is uncertain.
- A rebase is in progress.
- Checkout preparation started and did not complete.

Otherwise it saves the checkout's work before removing it:

- Staged changes go to `dropped/ACTION_ID-repo.patch.index.patch`. The whole working tree, including untracked files that Git doesn't ignore, goes to `dropped/ACTION_ID-repo.patch`. Each patch is binary-safe, names its base commit and applies with `git apply --index` on that base. The pipeline prepares both from a copy of the index, so saving changes nothing in the checkout.
- A manifest, `dropped/ACTION_ID.json`, records the repository, issue, branch, action, task, outcome, reason, and each snapshot's kind and base. It is written only when there is a patch.
- Commits that no remote branch holds go to a verified, self-contained bundle, `recovery/ACTION_ID-code.bundle`. If the remote can't be read, the pipeline bundles the commits anyway.

Only then does it reset and remove the checkout and release its lane slot. Closing a checkout pushes nothing. Each artifact is created exclusively, so existing evidence is never overwritten. An unmerged index, a failed save or a failed removal guard keeps the checkout; any patches already saved stay as well.

The action run observation records a kept checkout in `preserved.checkout` and the saved patches in `preserved.patches`. Nothing applies, replays or pushes saved evidence, and no later session is told about it.

The runtime releases the issue's execution only when nothing holds it. Each of these keeps the issue held:

- A result record that may not have been written.
- A kept checkout.
- A held model-session reservation.
- An uncertain checkpoint.
- An unreconciled coordination journal.
- A remaining lane-slot consumer.

## Lane test environments

A lane slot is one reusable test environment from a fixed local pool. The optional operator config `laneSlots`, an integer from 1 through 399, sets the pool size. Without `laneSlots` there is no pool, no slot variable and no setup barrier.

Implement, Harden, Sync, Integrate and Review Security declare the `test-slot` resource. Land and Complete don't. See [reservations](reservations.md) for the other resources.

### Slot allocation

When an acting `test-slot` action opens its checkout, the pipeline takes the metadata clone's lock. It registers the checkout's path as a consumer of the issue's lease before it creates the checkout. An issue that already holds a slot keeps it; otherwise it gets the lowest free slot. One issue holds at most one slot.

The pipeline refuses the checkout, creating nothing, when:

- No slot is free. The refusal asks for a retry after an issue checkout is removed.
- The issue holds a slot above the current `laneSlots`.

A lease lasts while any registered checkout still exists or any setup barrier is pending. Removing the last checkout releases the slot, under the same lock. Saved patches and bundles hold no slot. A lease whose checkouts were never created and that has no pending setup is dropped at the next read.

### Slot environment

With `laneSlots` set, a `test-slot` action's model sessions receive `ISSUE_PIPELINE_LANE_SLOT=K`, where `K` is the issue's leased slot. The pipeline removes any inherited value first, and other tasks' sessions receive none. Setup and check commands read `K` from the lane store. A check for an issue with no usable lease refuses rather than fall back to a default environment.

### Task-owned setup

Each task prepares its own test environment. Implement, Harden, Sync and Review Security call the action's `prepare` step before their first model session. With `laneSlots` or `commands.setup` configured, a `test-slot` task's sessions are refused until its checkout is prepared.

The `prepare-checkout` op runs the configured setup. It refuses unless all of these hold:

- It runs in the action's own checkout.
- The action is the original, unsettled attempt of a `test-slot` task.
- The action still owns the issue's execution.

The op creates `setup-ACTION_ID.started` exclusively before it runs setup, so a started setup is never replayed. The marker only refuses replays; it grants no readiness. With `laneSlots`, the pipeline also records the checkout as a pending-setup barrier before the command starts, and clears it only when setup exits 0. With `laneSlots` and no `commands.setup`, preparation only checks that no barrier is pending.

A setup that fails, times out or loses its reply ends the action. The pipeline keeps the checkout, the issue's execution and, with `laneSlots`, the slot and the barrier. No session starts and nothing retries the setup. No pipeline command clears a pending barrier or replays a started setup; reconcile it explicitly.

Integrate runs setup and the configured checks in a detached checkout under `integrate-*/`, a worktree of the metadata clone. A failed or unfinished setup keeps that folder and, with `laneSlots`, its barrier, and the action holds the issue. Checks that change tracked files keep the folder with a `tracked.patch` and fail the run.

A pending barrier keeps its lease even after the registered checkout is gone.

### Teardown and prune

The action runtime runs no configured teardown. While `commands.teardown` is set, every acting `test-slot` action refuses before it creates a checkout or environment, and `prepare-checkout` checks again. Read-only recovery and tasks without a test slot are unaffected. To run `test-slot` tasks, omit `commands.teardown`.

Nothing in the pipeline runs `commands.teardown`.

`commands.prune` is accepted and reserved for lane-resource maintenance. Nothing in the pipeline runs it at this source revision.

### Pool changes

Changing `laneSlots`, `commands.setup` or `commands.teardown` is an operator configuration change; landing source changes none of them. Before reducing the pool, drain every action and test consumer and remove their checkouts. An issue that still holds an out-of-range slot refuses new checkouts. The lane store can't see manual test users, so drain those separately.

## Process cleanup

Configured commands run through `shell-supervisor.mjs` in process groups that the pipeline owns. Ending a command sends `SIGTERM` to its whole group, waits, then sends `SIGKILL` to what's left. A group that is already gone counts as ended. Cleanup stops only the pipeline's own groups.

## Recover a retained checkout

1. Stop new work for the issue, for example with `agents:stop`.
2. Read the action's `run.json` for its reason, ownership, `preserved.checkout` and `preserved.patches`.
3. Copy the retained checkout and the issue's `dropped/`, `recovery/` and `integrate-*/` evidence outside `$ISSUE_PIPELINE_ROOT`.
4. Decide explicitly which saved work to keep. Patches without a manifest need manual reconciliation, since their branch can't be inferred.
5. Remove the retained checkout only after no consumer still uses it.

Land, Complete and Sync have read-only recovery. When one of their attempts is unsettled, a new action run in `recover` mode settles that original attempt from reads alone. It records no new attempt, takes no lane slot and runs no setup. An unsettled attempt of any other task stays held for explicit reconciliation.

There is no restart-at-stage command. See [recover after a source defect](operations.md#recover-after-a-source-defect) and [recovery boundaries](stops-and-labels.md#recovery-boundaries).
