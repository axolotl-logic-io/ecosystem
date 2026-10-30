# Land task

`@ecosystem/land` exports `land` and `landInputs`. Invoke it with `executeTask` from
`@ecosystem/task-framework`. Its only inputs identify the repository and issue.
It needs no model, buddy configuration or filesystem root.

The host supplies fresh GitHub recovery reads, guarded transport and artifact
publication. Land owns prerequisite decisions and domain writes: draft conversion
for conflicts, pinned-head merge and issue closure. Lifecycle labels and end
comments remain with the host adapter.

## Outcomes and retry identity

The issue's PR and authoritative merged state identify the merge across attempts.
Land reads reviews, permissions, required checks, base ancestry and current PR
state. Approval and absence of standing changes requests must apply to the same
head, and the PR must be ready. Missing prerequisites return `blocked`. A closed,
unmerged PR returns `needs-input`. A handled conflict returns `completed`, marks
the PR draft and names `start:fix` without merging.

The merge uses `--match-head-commit` and never bypasses protection. A changed head
is refused. After a merge, including a lost command response, Land reads GitHub's
state before closing the issue. A retry of a merged PR returns `no-change` and
reconciles closure without merging again. Reports of a confirmed merge are
published before closure so a failed close retains evidence for the next attempt.

## Validation and compatibility

Run `npm run check --workspace @ecosystem/land` for types, lint and direct
capability tests. The root full gate also exercises the installed compatibility
CLI against fake GitHub/model services and real local Git. Existing executable
names and installed prompt names remain functional. A source merge activates
nothing; follow the [pipeline install procedure](../../apps/issue-host/README.md#install-and-safe-upgrades).
