# Verify task

`@ecosystem/verify` exports `verify` and `verifyInputs`. Invoke it with `executeTask`
from `@ecosystem/task-framework`. Strict inputs name the issue, verified reviewer,
base branch, test command, resolved model and required-CI policy/deadline.

The host supplies a checkout of the pinned head, full checks, a credential-free
read-only model, diff ranges, text redaction, fresh PR reads and guarded review
submission. The task owns review planning, Security severity, CI interpretation
and exact-head retry decisions. Time is supplied through the sleep capability,
so direct tests do not wait. `session.ts` owns the model's task text; prompts,
reply schemas and decision tests also live in this workspace.

## Outcomes and retry identity

Repository, PR, acting reviewer and head identify one review. A judging review by
that account on that head returns `no-change`, including a concurrent review found
before submission. A missing open PR returns `blocked`. Successful judgment returns
`completed`. The PR author cannot review their own work. A moved head, mutated
read-only checkout or unusable model result fails without submitting a review.

Full checks and required CI judge the pinned head. Any Security finding blocks,
even if the model calls it a nit. Before submission Verify refreshes PR state and
requires the same open head. Submission binds `commit_id` to that head; the runtime
adapter owns persistence markers. Failed reviews retain the checkout; successful
and stopped runs follow the issue host's cleanup policy.

## Validation

Run `npm run check --workspace @ecosystem/verify` for types, lint and direct
capability tests. The root full gate also runs the installed `verify.mjs` program
against fake GitHub/model services and real local Git. A source merge activates
nothing; follow the [pipeline install procedure](../../docs/reference/operations.md#install-a-release).
