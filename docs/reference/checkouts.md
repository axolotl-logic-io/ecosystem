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
