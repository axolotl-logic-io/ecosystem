# Coordination

This page describes how a caller runs the pipeline: invoking stage jobs, reading their results, and keeping concurrent work apart. The rules are in [operations decisions](../decisions/operations.md).

## Run a stage job

The caller chooses each job's issue, stage and branch. Run the installed `job.mjs` once per stage, with one `--issue` and a required `--branch`:

```bash
node "$ISSUE_PIPELINE_ROOT/job.mjs" --config CONFIG \
  --issue ISSUE --branch BRANCH --lane LANE --stage STAGE
```

- `CONFIG`: the repository's config file, usually under `$ISSUE_PIPELINE_ROOT/repos/`.
- `ISSUE`: the issue number.
- `BRANCH`: the issue's branch. It must be a literal ref and not the base, the remote's default branch or another protected branch.
- `LANE`: a stable claimant name, the same for every stage of the issue.
- `STAGE`: `implement` for ordinary new work, `author` to explicitly use Author for new work, then the saved next stage (`implement`, `review` or `merge`).

Optional flags:

- `--merge-queue N1,N2,…` passes the caller's merge order (see [merge](merge.md#merge-order)).
- `--print-boundary` pins and checks the prompt pages and prints the stage's role, checkouts, environment and network as one JSON line, without cloning, claiming or starting a session.
- `--job-id UUID` names the job; without it, the job makes its own.

To steer a running session, run `job.mjs --config CONFIG --issue ISSUE --steer LAUNCH_KEY --message TEXT`. It exits 0 once Pi accepts the message.

## Read the result

A job prints one JSON line, `{"issue", "stage", "end", "reason"?, "claimError"?}`, and exits 0, even when it stops the issue. It exits 1, with the reason on stderr, only when the job itself fails: bad arguments, a refused config or branch, a prompt page it can't pin, or a failed op of its own. A signal exits 128 plus the signal number, after saving the claimed issue at its last saved state with no lease.

| `end` | Meaning | Caller's next step |
|---|---|---|
| `next` | The stage finished and saved the next stage | Run the saved next stage on the same branch and lane |
| `stop` | A control failed; the issue has a stop label | See [stops and labels](stops-and-labels.md) |
| `ask` | The pipeline asked a question (`agent:needs-info`) | Wait for a trusted answer |
| `wait` | The issue waits, for example for its merge turn | Retry later |
| `deferred` | A rate limit or transient error deferred it | Back off, then retry |
| `unclaimed` | Another claimant holds it, or the claim failed | Check `reason` and `claimError` first |

Don't loop blindly on `unclaimed`, `wait`, `deferred` or `stop`. A restarted job always starts its stage fresh from saved state. A job whose issue is saved at a different stage releases it without running a session; a `merge` job also completes a finished issue's recorded completion.

## Keep concurrent work apart

- Parallel jobs must use different issues and branches. Never run the same issue or branch twice at once, even from the same lane.
- Run merge turns one at a time. A merge queue is an order, not permission to merge concurrently.
- Keep each issue's branch and lane stable across restarts. The first claim binds the branch; a different branch later is refused.

Caller serialization doesn't exclude outside actors. Anyone with access may push, merge, retarget or change settings at any time. Observed invalid authority refuses writes; unseen concurrent changes aren't prevented atomically.

## Prerequisites and sub-issues

An issue's `after` marker names prerequisite issues. The legacy scheduler and assignment discovery hold an issue while a prerequisite is open, and treat an unreadable dependency as a hold. A stage job doesn't check prerequisites, so the caller must. An issue labeled `agent:split` was split into sub-issues; its parent closes once every sub-issue is closed.

## Code that isn't the caller's entry point

These exist in source but are not how the caller runs the pipeline:

- **`orchestrate.mjs`** is a retained legacy scheduler (`--config PATH [--once]`). Don't run it alongside caller-managed jobs.
- **The coordination seam** (`src/coordination-records.ts`, `src/coordination.ts`, `src/execution.ts`) is an explicit-only protocol for execution and integration-turn records. Nothing in `job`, `ops`, `orchestrate` or `report` reaches it, and assignment mode is disabled.
- **Assignment discovery** (`src/discovery/plan.ts`) is a read-only, opt-in module. Its plans state `executionAuthority: false`: they grant no session, claim, write or merge.

## Recover from a coordination problem

1. Stop dispatching the affected issues.
2. If two jobs ran on one issue or branch, keep both jobs' run folders and recovery evidence. Read the issue's saved state to see which claim won.
3. If the seam's `coordination-uncertain.json` exists in the issue's run folder, keep it. A lost response may still have landed; reconcile against GitHub with reads before any retry.
4. Restart one job on the issue's saved stage, with its original branch and lane.
