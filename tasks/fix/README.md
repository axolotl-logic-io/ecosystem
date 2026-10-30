# Fix task

`@ecosystem/fix` exports `fix` and `fixInputs`. Invoke it with `executeTask` from
`@ecosystem/task-framework`. Strict inputs name the issue, verified account,
independent Verify account, full test command and resolved model.

The host supplies fresh PR reads, guarded issue/review operations and a private
writer. The writer merges the base without rebasing, exposes conflicts and uses
credential-free model sessions. The task owns standing-review selection, trusted
issue text, reply validation and publication decisions. Successful work removes
its private checkout; failures and requests for help retain it.

## Outcomes and retry identity

The issue's PR and pushed head identify the work to continue. Blocking thread root
ids and replies by the acting account identify answered findings. A retry reads
current reviews and unresolved threads, skips nits and answered threads, and
rechecks replies before posting. A non-fast-forward push cannot overwrite another
run; no reply is posted when publication fails.

A missing open PR returns `blocked`. A fourth Verify-triggered round or a model
that cannot finish returns `needs-input`. A run that changes neither the head nor
thread replies returns `no-change`; other successful work returns `completed`.
Review counts come from GitHub, not an attempt counter. The third round is allowed.

`review.ts`, `reply.ts` and `prompts/fix.md` are task-owned. Marker formats and
credential provisioning remain host/runtime concerns.

## Validation and compatibility

Run `npm run check --workspace @ecosystem/fix` for types, lint and direct
capability tests. The root full gate also exercises the installed compatibility
CLI against fake GitHub/model services and real local Git. Existing executable
names and installed prompt names remain functional. A source merge activates
nothing; follow the [pipeline install procedure](../../apps/issue-host/README.md#install-and-safe-upgrades).
