# Telemetry

A task app writes `runs/SLUG/issue-N/task-runs/RUN_ID/run.json` only after winning its start claim. The record describes its lifecycle, account, process, timestamps and outcome. It grants no authorization. The launcher writes app exits and unreadable start listings to stderr.

Model transcripts live alongside the task run in `sessions/`. A commit made through `pipeline_commit` carries a `Pipeline-Session` trailer with the launch key and session start. The trailer attributes a commit to a session; it does not prove that publication succeeded or allocate model cost.

The workflow dashboard still reads historical buddy-run and action-run files, as well as current task runs and Project Buddy observations. Its `monitor_entities`, `monitor_events` and `monitor_cursors` tables are independent of coordination storage. Missing evidence remains unknown, never zero use or a live run inferred from a filename.

Transcripts can contain private paths, prompts and tool output. Preserve them for diagnosis without publishing them blindly. Recovery reads GitHub artifacts and retained work, not an authority ledger reconstructed from telemetry.
