# Telemetry

The pipeline records buddy runs, task actions and model sessions. These observations describe what happened; they grant no authority, continuation or retry. Usage measures are not a spending budget.

## Current local records

Under `$ISSUE_PIPELINE_ROOT`, the current runtime writes:

| Path | Content |
|---|---|
| `runs/buddy-runs/BUDDY_RUN_ID/run.json` | The buddy's scope, identity, task loops and end observation |
| `runs/SLUG/issue-N/actions/ACTION_ID/run.json` | The action's binding, cause, mode, operations, sessions, reservations, checkpoint, ownership and preserved work |
| `runs/SLUG/issue-N/actions/ACTION_ID/sessions/KEY.jsonl` | One model session's transcript |
| `runs/SLUG/issue-N/actions/ACTION_ID/context.jsonl` | Bounded measures for each ended session |
| `runs/SLUG/issue-N/pushes.jsonl` | The pipeline's own push records |

`BUDDY_RUN_ID` and `ACTION_ID` are separate run UUIDs. `SLUG` is the repository name with `/` replaced by `__`, `N` is the issue number, and `KEY` is a launch key such as `developer-hardening-1`. A session also has its own UUID and an explicit parent action. See [runtime run observations](runtime-runs.md) for schemas, lineage and conservative process observations, and [checkouts](checkouts.md) for recovery artifacts.

The action runtime writes no `job.json` or `job.log`, and no usage records on GitHub.

A context entry records its launch key, session file, model role, task label, measured tokens and turns, context measures, and code heads when available. Its technical `job` field names the action, and `stage` holds the task ID; neither introduces a separate job or scheduler stage. `interrupted` describes a local interruption, not a fabricated accepted human stop. `unrecorded` means launch evidence is missing. Missing measures do not prove zero use or cost.

Local transcripts can contain prompts, replies, tool output and private paths. Bounded serialization does not make them safe to publish.

## Commit attribution

A commit made through `pipeline_commit` carries `Pipeline-Session: LAUNCH_KEY@ACTION_START`. Match its launch key and start time to the action and its session observations. The trailer attributes a commit to a session, not a share of its cost. Neither a trailer nor a local commit proves that a push succeeded.

## Investigate missing telemetry

Read the canonical buddy and action observations, the action's `context.jsonl` and session transcripts, and the issue's push records. Check explicit run and session links rather than inferring them from filenames or process age. Gaps in telemetry grant no permission to repeat an effect. If exact attribution is missing, preserve the gap rather than reconstruct it from guesses.
