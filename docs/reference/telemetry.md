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

The action runtime writes no current `job.json` or `job.log`. Preserve older files as historical evidence; do not interpret them as a current stage cursor.

A context entry records its launch key, session file, model role, task label, measured tokens and turns, context measures, and code heads when available. Its technical `job` field names the action, and `stage` holds the task ID; neither introduces a separate job or scheduler stage. `interrupted` describes a local interruption, not a fabricated accepted human stop. `unrecorded` means launch evidence is missing. Missing measures do not prove zero use or cost.

Local transcripts can contain prompts, replies, tool output and private paths. Bounded serialization does not make them safe to publish.

## Commit attribution

A commit made through `pipeline_commit` carries `Pipeline-Session: LAUNCH_KEY@ACTION_START`. Match its launch key and start time to the action and its session observations. The trailer attributes a commit to a session, not a share of its cost. Neither a trailer nor a local commit proves that a push succeeded.

## Historical GitHub usage records

The standalone `usage` op and usage-report reader remain available for the older hidden usage-comment format. The current buddy runtime does not append those session or job totals. A usage report can therefore omit current buddy sessions; it is not a complete activity or liveness report.

Historical records contain constrained identifiers and numerical measures, including token counts, context and optional cost in US dollars. A session total and its containing job total count the same work; do not add them together. Missing cost is not zero spend.

## Read the usage report

```bash
node "$ISSUE_PIPELINE_ROOT/report.mjs" usage --config CONFIG \
  --since 2026-01-01 --role reviewer --issue ISSUE
```

`CONFIG` is the operator's repository config file. `ISSUE` is an issue number. `--since`, `--role` and `--issue` are optional; the date is an ISO date or timestamp.

The report selects hidden usage records by the configured landing account's login. It groups session records by model role, historical state label and model, with median, 90th-percentile and maximum context and tokens, flagged sessions, and tools with the most output. This telemetry selection is not authentication of task results or current workflow authority.

Flags annotate the report; nothing acts on them. `usageFlags` in the repository config sets their thresholds:

| Flag | Raised when | Setting |
|---|---|---|
| `first-context` | First-turn context exceeds the threshold | `firstContext`, default 40,000 |
| `tool-output` | The largest tool output exceeds a share of peak context | `toolOutputShare`, default 0.25 |
| `first-grew` | A later attempt's first-turn context exceeds the latest earlier session's at the same issue and state | — |
| `past-soft` | A historical record contains a soft threshold | — |

## Investigate missing telemetry

Read the canonical buddy and action observations, the action's `context.jsonl` and session transcripts, and the issue's push records. Check explicit run and session links rather than inferring them from filenames or process age. Gaps in telemetry grant no permission to repeat an effect. If exact attribution is missing, preserve the gap rather than reconstruct it from guesses.
