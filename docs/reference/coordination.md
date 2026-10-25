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
- `STAGE`: `implement` for ordinary new work, `author` to explicitly use Author for new or eligible saved direct-mode work, then the saved next stage (`implement`, `review` or `merge`).

Optional flags:

- `--landing-order N1,N2,…` passes the caller's landing order (see [merge](merge.md#landing-order)).
- `--hardening-buddy hippy` hardens as Hippy, the Developer, in a fresh session; only with `--stage review`. The caller always passes it.
- `--task sync|integration --binding BINDING_JSON` runs a requested task instead of the stage: Hippy's [Sync](sync.md) at `review` or `merge`, or Lawd's read-only [Integration](merge.md#read-only-integration-and-exact-land) at `merge`. `STAGE` is the issue's saved stage, and `BINDING_JSON` is the request's binding, exactly. The job refuses a binding for another task, issue, repository or target branch before it claims or writes anything. A task job runs as its task's access profile: Sync as `writer`, Integration as `reader`.
- `--print-boundary` pins and checks the prompt pages and prints the stage's role, checkouts, environment and network as one JSON line, without cloning, claiming or starting a session.
- `--job-id UUID` names the job; without it, the job makes its own. It is never the run's ownership: the job mints a fresh invocation UUID for that (see [Keep concurrent work apart](#keep-concurrent-work-apart)).

To steer a running session, run `job.mjs --config CONFIG --issue ISSUE --steer LAUNCH_KEY --message TEXT`. It exits 0 once Pi accepts the message.

## Read the result

A job prints one JSON line, `{"issue", "stage", "end", "reason"?, "claimError"?, "request"?, "task"?}`, and exits 0, even when it stops the issue.

- `request` is `{task, binding}`: the task a waiting stage needs before it can go on, such as Sync when the revision misses the target, or Integration before Land. Start that task next.
- `task` is a task job's report of its run: `{task, binding, run, verdict}`. `verdict` is `passed`, `failed` or `refused` when the run recorded one, `held` when its records or a limit need a person, and `unknown` when the job ended without establishing one. A task's verdict is separate from the job's `end`. It exits 1, with the reason on stderr, only when the job itself fails: bad arguments, a refused config or branch, a prompt page it can't pin, or a failed op of its own. A signal exits 128 plus the signal number, after saving the claimed issue at its last saved state with no lease.

| `end` | Meaning | Caller's next step |
|---|---|---|
| `next` | The stage finished and saved the next stage | Run the saved next stage on the same branch and lane |
| `stop` | A control failed; the issue has a stop label | See [stops and labels](stops-and-labels.md) |
| `ask` | The pipeline asked a question (`agent:needs-info`) | Wait for a trusted answer |
| `wait` | The issue waits, for example for its turn to land, or for the task its `request` names | Start the requested task; otherwise retry later |
| `deferred` | A rate limit or transient error deferred it | Back off, then retry |
| `unclaimed` | Another claimant holds it, or the claim failed | Check `reason` and `claimError` first |

Don't loop blindly on `unclaimed`, `wait`, `deferred` or `stop`. A restarted job always starts its stage fresh from saved state. An eligible explicit `author` job checkpoints saved direct-mode work at Author and retains its return stage. Other jobs whose issues are saved at different stages release them without running a session; a `merge` job also completes a finished issue's recorded completion.

## Keep concurrent work apart

- Parallel jobs must use different issues and branches. Never run the same issue or branch twice at once, even from the same lane.
- Each exact Land takes the [target's integration turn](merge.md#the-targets-integration-turn) before it writes the target, so a second Land on the same target ends `wait`. The landing order is an order, not permission to land concurrently.
- Keep each issue's branch and lane stable across restarts. The first claim binds the branch; a different branch later is refused.
- Each job confirms issue-execution ownership for a fresh invocation UUID before it opens a checkout or runs an op. A second job on the same issue and branch, from any lane, ends `unclaimed` with `reason` "another invocation owns the issue" and starts nothing. The owner releases only when the release predicate passes (#151): a confirmed checkpoint, no unresolved stop or uncertain write, preserved work and no registered lane-slot consumer. Any other job keeps ownership until someone reconciles it, and says why on stderr (`job: execution held: …`). A job whose claim was refused also shows a `claimError` on `unclaimed`.

Caller serialization doesn't exclude outside actors. Anyone with access may push, merge, retarget or change settings at any time. Observed invalid authority refuses writes; unseen concurrent changes aren't prevented atomically.

## Prerequisites and sub-issues

An issue's `after` marker names prerequisite issues. The legacy scheduler and assignment discovery hold an issue while a prerequisite is open, and treat an unreadable dependency as a hold. A stage job doesn't check prerequisites, so the caller must. An issue labeled `agent:split` was split into sub-issues; its parent closes once every sub-issue is closed and at least one has landed.

## Code that isn't the caller's entry point

These exist in source but are not how the caller runs the pipeline:

- **`orchestrate.mjs`** is a retained legacy scheduler (`--config PATH [--once]`). Don't run it alongside caller-managed jobs. It relays no task request, so since #186 a merge it starts waits for an Integration it never starts.
- **Assignment mode** is disabled.

## Recover from a coordination problem

1. Stop dispatching the affected issues.
2. If two jobs ran on one issue or branch, keep both jobs' run folders and recovery evidence. Read the issue's saved state to see which claim won.
3. If the transport's `coordination-uncertain.json` exists in the issue's run folder, keep it. A lost response may still have landed; reconcile against GitHub with reads before any retry. A `coordination-inflight-PID.json` is a write in flight; once process `PID` has ended, it holds the issue the same way.
4. Restart one job on the issue's saved stage, with its original branch and lane.

## Compatibility and limits

[#133](https://github.com/axolotl-logic-io/ecosystem/issues/133) proved issue-execution fencing through real job boundaries, and [#171](https://github.com/axolotl-logic-io/ecosystem/issues/171) the target's integration turn. These are the proved behaviors and the limits that remain.

- **Saved data keeps reading.** Coordination records keep version 1 and their historical `identity` key. A retained `coordination-uncertain.json` from before #133 still holds its issue. The new turn records are ordinary version 1 records in the integration scope; a retirement adds only an `evidence` field, which version 1 already allows.
- **Every job must run the same release.** The per-writer journal and the integration turn exist only in this release. An older job doesn't take the turn, and its write in flight, named `coordination-uncertain.json`, holds every newer job on the issue. Drain every old job before installing.
- **Outside actors aren't excluded.** Anyone with access may push, merge, retarget or change settings at any time. Observed invalid authority refuses writes; unseen concurrent changes aren't prevented atomically.
- **Liveness of an in-flight journal is a process check on one machine.** A journal names its process ID. A job on another machine sees only its own run folder.
- **A held issue or turn needs a person.** No expiry, lease age or restart takes over either one.

### Scenario trace

Each row names the scenario and the test that proves it through real binaries.

| Scenario | Proved by |
|---|---|
| A fresh UUID per invocation; a duplicate job on the same or another lane, live or expired, starts nothing | #167, #150: `test/job/job-invocation.test.ts` |
| Immutable binding on every ops, steer and push request; owner reread before each session and push | #168: `test/job/job-binding-fence.test.ts`, `test/job/job-writer-fence.test.ts` |
| Release only through the release predicate; uncertain saves, lost releases, failed preservation and signals hold | #151: `test/job/job-release-predicate.test.ts` |
| Every credentialed write rereads ownership; a lost reply holds through a restart | #169: `test/ops/ops-write-fence*.test.ts`, `test/task-write-fence.test.ts`, `test/completion-write-fence.test.ts` |
| Teardown, exit salvage and cleanup fenced on ownership and lane-slot consumers | #170: `test/job/job-fenced-exit.test.ts`, `test/ops/cleanup-fence.test.ts` |
| Two jobs request at the same instant, on one lane or two: one writer starts, the loser refuses cleanly | #133: `test/pipeline-flow-contention.test.ts` |
| A predecessor delayed past its successor's confirmation: its push, save and release are refused, the successor's records unchanged | #133: `test/pipeline-flow-contention.test.ts` |
| A lost acquisition holds through a restart, with no second reservation | #133: `test/pipeline-flow-contention.test.ts` |
| Malformed, conflicting, missing or untrusted coordination authority holds | `test/coordination-recovery.test.ts`, `test/execution-transport.test.ts` |
| One Land writes a target at a time; the waiting order is read from GitHub after the run folders are deleted | #171: `test/land-turn.test.ts` |
| A lost turn write holds the turn and the issue, with no second POST | #171: `test/land-turn.test.ts` |
| An unsettled Land holds the turn; a dead Land's turn is retired only by its own issue; a late release is refused | #171: `test/land-turn.test.ts`, `test/land-task.test.ts` |
| Assignment discovery, grants and the full composed loop | Not yet proved: #120, #121 |
