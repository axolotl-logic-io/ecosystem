# Telemetry

This page describes what the pipeline records about sessions and jobs, where those records live, how commits trace back to sessions, and the usage report. Usage is telemetry, not a budget: nothing stops a session for its spend or context size.

## Usage records on GitHub

Each finished session and job adds a schema-checked JSON line to a hidden block in the issue's usage comments, posted by the review/merge account. A full comment rolls over to another. Records hold numbers, booleans, times and constrained identifiers, never task text, free-text replies, prompts or raw tool output.

A **session record** names the repository, issue, job, job start, launch key, stage, phase, role, agent, model and attempt. It also records:

- how it ended (`reply`, `error` or `aborted`), the reply name, seconds and turns;
- tokens: `input`, `output`, `cacheRead`, `cacheWrite`, optional `cacheWrite1h` (the subset written at the one-hour rate) and optional `cost` in US dollars, summed from Pi's per-message cost. A missing cost isn't zero spend;
- context: `first`, `peak` and `atFinish` per-turn context, counted as input plus cache-read plus cache-write tokens. This isn't cumulative spend;
- prompt provenance: the page name and the SHA-256 of its pinned bytes. Its `head` is null for pages that ship with the pipeline.

A **job record** names the repository, issue, job, job start and role, with the stages visited, outcome, duration and summed session tokens. Don't add job totals to session totals; that counts them twice.

Logging is best effort and never stops an issue. A serializer refusal is dropped with its reason in `job.log`; a failed append is retried once, then dropped.

## Local records

In `runs/SLUG/issue-N/` (see [checkouts](checkouts.md)):

- `sessions/KEY.jsonl` holds each session's transcript. Reusing a key moves the earlier transcript to `KEY.STAMP.jsonl`.
- `context.jsonl` adds one entry per ended session with `key`, `job`, `session`, and the code head at session end.
- `job.json` records each launch, its pinned prompt pages and its verified `runtimePolicy` (see [runtime](runtime.md)). A null policy means no policy was accepted, for example for an op or a launch refused before verification.
- `pushes.jsonl` adds `{key, job, repo, sha, at}` for each push.

Local logs are diagnostic and recovery evidence, not permission to change GitHub. The usage serializer's limits don't make local logs safe to publish.

## Commit attribution

Each commit made through `pipeline_commit` carries `Pipeline-Session: LAUNCH_KEY@JOB_START`. Match it to the session's usage record by launch key and job start, and to push records by launch key and job. A trailer attributes a commit to a session, not a share of its cost. A trailer or a local commit isn't proof of a push.

## Usage report

```bash
node "$ISSUE_PIPELINE_ROOT/report.mjs" usage --config CONFIG \
  --since 2026-01-01 --role reviewer --issue ISSUE
```

`--since` (an ISO date or time), `--role` and `--issue` are optional. The report reads the review/merge account's usage records and groups sessions by role, state and model, with median, p90 and maximum context and tokens, flagged sessions, and each role's tools with the most output.

Flags annotate the report; nothing acts on them. `usageFlags` in the repository config sets their thresholds:

| Flag | Raised when | Setting |
|---|---|---|
| `first-context` | First-turn context is above the threshold | `firstContext`, default 40,000 |
| `tool-output` | The largest tool output is above a share of peak context | `toolOutputShare`, default 0.25 |
| `first-grew` | A later attempt's first-turn context exceeds the latest earlier session's at the same issue and state | — |
| `past-soft` | A historical record contains a soft threshold; current jobs don't emit one | — |

## Recover missing telemetry

Telemetry gaps need no recovery for the issue to proceed. To investigate, read `job.log` for dropped records, then `job.json`, `context.jsonl` and `pushes.jsonl` for the same job. If a trailer or record is missing, exact attribution isn't available; don't reconstruct it from guesses.
