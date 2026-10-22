# Fixture provenance

Copied read-only on 2026-10-20 from:

- `~/.pi/agent/issue-pipeline/runs/axolotl-logic-io__project-buddy/issue-494/{job.json,jobs.jsonl}`
- `~/.pi/agent/issue-pipeline/runs/axolotl-logic-io__project-buddy/issue-457/{job.json,jobs.jsonl}`
- `~/.pi/agent/issue-pipeline/runs/axolotl-logic-io__project-buddy/issue-299/job.json`

The copied JSON/JSONL contents are unmodified snapshots; no secret stripping was needed or performed. JSON inputs have a `.json.txt` suffix in this repository, including the deliberately malformed input. The fixture test kit restores their filenames in a disposable directory without changing their bytes. These are data samples, not maintained JSON configuration. The source for issue 299 had no `jobs.jsonl`, so this also tests a missing optional journal. Tests never check the real fixture PIDs against the machine; their liveness function is mocked.

Synthetic additions:

- `runs/axolotl-logic-io__project-buddy/issue-999/job.json.txt`: deliberately incomplete JSON.
- `runs/axolotl-logic-io__project-buddy/issue-494/verify-9/test.log`: clearly marked synthetic verification summary, not a claim about a real pipeline test run.
- `gate/sessions/reviewer-2.jsonl`: synthetic currently open `npm run gate:web` bash call for read-only web-gate detection; no gate command is executed.

Tests read only these local files and do not mutate the live pipeline.
