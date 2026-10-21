# Checkouts

This page describes where the pipeline keeps clones, job checkouts and run files, what a job saves when it ends, and how commands are cleaned up. The rules are in [operations decisions](../decisions/operations.md#worktrees-and-branches).

## Layout

Everything lives under `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`). `SLUG` is the repository's config slug and `N` the issue number.

| Path | Holds |
|---|---|
| `clones/SLUG` | The repository's metadata clone |
| `work/SLUG/mirror.git` | A bare mirror that job checkouts clone from |
| `work/SLUG/jobs/issue-N-STAGE/` | One job's folder; every session runs here, and the code checkout is `repo/` |
| `runs/SLUG/issue-N/job.log` | The issue's job log |
| `runs/SLUG/issue-N/job.json` | The current job's status, launches, prompt provenance and runtime policy |
| `runs/SLUG/issue-N/sessions/KEY.jsonl` | Each session's transcript |
| `runs/SLUG/issue-N/context.jsonl`, `jobs.jsonl`, `pushes.jsonl` | Session context records, job records and the pipeline's own pushes |
| `runs/SLUG/issue-N/dropped/` | Recovery patches, manifests and bundles |
| `runs/SLUG/issue-N/stop-recovery/` | Stop reconciliation evidence (see [stops and labels](stops-and-labels.md)) |

`clones/`, `work/` and `runs/` are local caches and recovery evidence, not authority. Keep them, and any saved patches, through upgrades until preserved work is confirmed safe.

## What a job saves when it ends

On every exit, a job closes its checkout before removing it:

- Uncommitted changes are saved as binary-safe patches of the index and the working tree, `dropped/KEY-repo.patch`. Each applies on its recorded base. A separate index is used, so a failed save leaves files, staging and HEAD as they were.
- Local commits the remote lacks are saved in a verified, self-contained Git bundle.
- A job-keyed manifest records the branch, the stage's outcome and reason, the checkouts, the snapshot kinds and their bases.
- `job.json` records the dropped paths and the patches, and `job.log` names them.
- A stopped run posts one keyed comment on the issue saying patches were saved, naming the job key but never a local path.

If any of that can't be saved, the checkout is kept instead of removed, and a restart refuses to overwrite it. Existing evidence is never overwritten.

Nothing applies saved evidence automatically. A later hardening session on the same issue and branch is told where matching Review recovery evidence is, and incorporates useful edits within its current scope. A bundle left after a successful push is inert.

## Lane test environments

Optional repository config `laneSlots` enables a fixed, warm pool of test environments. It must be an integer from 1 through 399. Omit it to keep the existing per-issue behavior. The upper bound keeps project-buddy's app port blocks below its proxy ports; it is an interface limit, not an operator-selected concurrency value.

A claim reserves the lowest free slot under the metadata clone's lock, before posting its claim or running setup. Ownership is local to this pipeline root and repository. Concurrent claim processes cannot assign one slot to different issues. An exhausted pool refuses with a retry message and makes no claim mutation, setup call or prune attempt. The caller must not dispatch concurrent jobs for the same issue, even with the same lane name.

An issue keeps its slot while any recorded checkout directory survives. Reclaims reuse that slot regardless of job or GitHub lease expiry. Persistent worktrees therefore keep their slot across stages. Caller jobs use disposable stage clones: once the last actual checkout is removed, a later stage may receive another slot. Recovery failures retain the original checkout and its slot. Successfully saved patches and bundles alone do not reserve a slot. A crash before checkout creation leaves a reservation that the next claim can reclaim; a crash after creation keeps ownership until removal. Retain the local ownership record with the checkouts through upgrades and recovery.

With a pool enabled, every successful, non-done claim runs `commands.setup`, including claims using a pre-created caller clone. Setup and deterministic check commands receive `ISSUE_PIPELINE_LANE_SLOT=K`, where `K` is the leased slot. Existing issue checkout and run-directory identity remains unchanged. Setup readiness is recorded before the command starts. A failed or interrupted lane setup refuses model startup and keeps the original checkout and slot before any reset or recovery cleanup. Fix setup, explicitly retry the claim against the retained checkout, then reconcile/remove that checkout before restarting a disposable stage; the launcher will not overwrite it. A successful retry clears pending readiness. Legacy setup failures remain logged/nonfatal. A config without `commands.setup` needs no setup-readiness record.

Deterministic primary and detached merged verification run synchronously for the issue and reuse its slot. The fails-before-fix runner is retired; there is no additional test copy to schedule. The caller serializes each issue's writer and verification turns, and command supervision ends managed test children before a command returns and checkout removal proceeds. Do not run manual tests against an assigned slot or remove its checkout while a test consumer remains.

Optional `commands.prune` runs from the metadata clone's base checkout with `ISSUE_PIPELINE_LANE_SLOTS=N`. It requires `laneSlots`. Its attempts are checkpointed under the clone lock and run at most once per hour across claim processes, including after failure or restart. Maintenance holds that lock with a five-minute command limit; a failure is logged and does not fail the claim. Per-issue `commands.teardown` still works and can be omitted for a warm pool.

When reducing the pool, a surviving out-of-range owner is refused rather than moved or evicted. Prune is suppressed while any such checkout survives. Drain the affected jobs **and all test consumers** before removing their checkouts or reducing the pool. This local lease guard cannot identify legacy or manual test users. Before enabling prune for the first time, stop dispatch and drain/release **all** old-style jobs, retained issue environments, manual/session test environments and their test subprocesses. No running pipeline job is not sufficient evidence that legacy environments are unused.

### Rollout prerequisites

Merge project-buddy's scripts into its configured base branch before switching setup. Sync any older issue branches so they contain those scripts. With no jobs or test consumers running, the operator can install the accepted ecosystem release and change these project-buddy config fields together:

- Add `laneSlots` with Autumn's selected pool size, at most 399.
- Set `commands.setup` to `bash apps/web/scripts/test-env/setup.sh`.
- Add `commands.prune` as `bash apps/web/scripts/test-env/prune.sh`.
- Remove the old per-issue `commands.teardown` for the warm-pool configuration.
- Keep the existing `commands.test`.

Do not switch setup without `laneSlots`: the repo script intentionally uses the human/default environment when no slot is present. Do not enable legacy prune until every old environment consumer has drained. Source merge does not install or change operator config; no cleanup is part of this source change.

Project-buddy reserves the app port block `20000+10K` through `+9` and proxy port `24000+K`; there is no storage-down server at `+1`. Its prune script also matches legacy and out-of-range scratch databases. Connected databases/environments are retained without treating that retention as a command failure; actual removal errors are nonzero and logged by the pipeline. Ownership and active-connection checks belong to the repo script, not resource-name guesses in the pipeline. In-range scratch databases can remain after interrupted tests until a later test reuses them or a drained pool reduction makes them eligible for prune.

## Process cleanup

Configured commands run in process groups the job owns, through `shell-supervisor.mjs`. Ending a command sends `SIGTERM` to its whole group, waits, then sends `SIGKILL` to what's left. A group that is already gone counts as ended. Cleanup stops only the job's own groups.

## Cleanup op

The `cleanup` op frees the worktree, local branches and leftover resources of each closed issue whose work is all on GitHub. Anything in doubt is kept, with the reason.

## Recover a kept checkout

1. Stop dispatching the issue.
2. Read `job.log` and `job.json` to find the saved patches, bundle, manifest or kept checkout.
3. Copy the evidence somewhere outside `$ISSUE_PIPELINE_ROOT` before changing anything.
4. Recover or relocate the kept checkout explicitly; a restart refuses to overwrite it.
5. Restart the issue on its saved stage, branch and lane. The next writer decides what saved work to use. Patches without a manifest need explicit reconciliation, since their branch can't be inferred.
