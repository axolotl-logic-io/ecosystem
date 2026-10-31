# Stops and labels

A task starts only from its `start:TASK` label on the issue. GitHub permits accounts with triage access or higher to apply labels; the app does not qualify the label's author.

| Task | Start | Running indication |
| --- | --- | --- |
| Gherkin | `start:gherkin` | `agent:gherkin:running` |
| Implement | `start:implement` | `agent:implement:running` |
| Verify | `start:verify` | `agent:verify:running` |
| Fix | `start:fix` | `agent:fix:running` |
| Land | `start:land` | `agent:land:running` |

The framework removes the start and confirms its own account's removal on the timeline before doing the work. A running label shows activity and never blocks another start. Runs may overlap. End comments let a run remove its running label only when no other claim remains open. A crashed run can leave a running label for a person to clear.

`agents:stop` holds new claims while present. Task apps check it before claiming, between lifecycle steps and before writes; ending comments and unmarking remain allowed. Removing it permits a pending start to run. An in-flight model session may finish before the next check.

A failed run names the failed step and asks a person to apply the start again. A review, assignment, result or removal of a running label starts no task.

