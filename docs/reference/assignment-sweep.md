# Assignment sweep

The assignment sweep finds the work the grantor's GitHub assignments grant and starts it, so no one has to start each stage by hand. It's opt-in per repository and runs only when the operator runs it. Nothing installs or starts it.

The full operating guide and the #73 scenario audit land with #175. This page starts with what #120 delivers.

## Run one sweep

A repository takes part when its config names the grantor, the one account whose assignments grant and withdraw work ([`assignment-permission`](../decisions/buddies-and-tasks.md#assignment-permission)):

```json
{ "assignments": { "grantor": "axolotl-logic" } }
```

The sweep uses the caller's run folder, so `run.json`'s caps, attempts and exclusions apply to its starts exactly as to the caller's:

```sh
node "$ISSUE_PIPELINE_ROOT/sweep.mjs" --run RUN_DIR \
  --config "$ISSUE_PIPELINE_ROOT/repos/o__r.json" --lane sweep
```

It prints one JSON line per decision and exits:

```json
{"repo":"o/r","issue":7,"start":{"stage":"implement","task":null,"attempt":1,"receipt":"…"}}
{"repo":"o/r","issue":8,"hold":"refused: 1 jobs are live; the cap is 1"}
{"repo":"o/r","issue":9,"hold":"paused: axolotl-logic hasn't assigned dev-bot"}
```

## Repeat sweeps and durable holds

`--sweeps N --interval SECONDS` runs N sweeps (up to 1000) with an idle wait between them (default 60 seconds), then exits. SIGTERM or SIGINT ends it at the next sweep or during the wait. A sweep under way finishes first, and the sweep never touches a job it started: jobs run detached in their own process groups.

```sh
node "$ISSUE_PIPELINE_ROOT/sweep.mjs" --run RUN_DIR --config CONFIG \
  --lane sweep --sweeps 60 --interval 60
```

Each line then carries its sweep's number, `{"sweep": 3, "repo": …}`.

Nothing a sweep relies on lives only on this machine, so a restart, even with a new run folder, starts nothing twice:

| What stops a start | Where it's kept | What lifts it |
| --- | --- | --- |
| A live job on the issue | the run folder and job.json | the job ending |
| Another invocation owns the issue | GitHub coordination records | the owner's release, or a person's reconciliation |
| A pause | GitHub's assignment events and comments | a newer grant by the grantor |
| A stop or an unanswered question | the saved state | a person |
| A blocked end (`wait` with no task request, or `deferred`) | a hold record on the issue | a person's comment, label or assignment, a moved branch or target, or, for a deferral, its retry time |

A job started for an assignment that ends blocked writes the hold record: one keyed comment from the landing account, edited in place. It names the work that held, why, and the condition it waits on: the latest event and comment by anyone but the pipeline's accounts and the heads of the branch and the target. A deferral also sets a retry time, 1 minute after the first deferral of that work on that condition and doubling each time up to 1 hour. The sweep reads the record with landing-account authorship and editor provenance and skips the work while the condition is unchanged and the retry time hasn't passed. A hold applies only to the work it names, so progress is never held back. A body edit alone doesn't lift a hold; a comment does.
