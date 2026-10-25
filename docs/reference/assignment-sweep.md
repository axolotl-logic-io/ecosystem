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
