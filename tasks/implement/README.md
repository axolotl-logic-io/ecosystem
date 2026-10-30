# Implement task

`@ecosystem/implement` exports `implement` and `implementInputs`. Invoke it with
`executeTask` from `@ecosystem/task-framework`. Its strict inputs name the issue,
verified account, development account, base branch, full test command and resolved
model. The task reads no configuration and receives no credential environment.

The host supplies branch checkout access, a trusted issue brief, fresh recovery
reads, guarded GitHub operations and credential-free writer sessions. The task
owns draft creation, development, fresh hardening and the ready decision. The
checkout capability preserves divergent pushes on a recovery branch and bundles
unpublished work on close. The host reports retained-checkout failures.

## Outcomes and retry identity

The repository and issue identify `agent/issue-N` and its PR. Execution identifies
only the private attempt and its session push binding. A retry reuses pushed work
and the existing draft rather than resetting it. A merged PR returns `no-change`;
a closed PR or model request for help returns `needs-input`. Successful development
and hardening return `completed`. Execution, invalid-reply and push errors fail the
attempt; cleanup preserves recoverable work.

Implement refreshes PR state before confirming a draft and before marking ready.
The latter requires the remote head to match the published head. Every session
commit uses the host's stop-checked push callback. A moved head leaves the PR draft.

Prompts and the shared Developer agent definition live here. Fix uses that same
Developer definition; its task-specific prompt lives in `tasks/fix`.

## Validation and compatibility

Run `npm run check --workspace @ecosystem/implement` for types, lint and direct
capability tests. The root full gate also exercises the installed compatibility
CLI against fake GitHub/model services and real local Git. Existing executable
names and installed prompt names remain functional. A source merge activates
nothing; follow the [pipeline install procedure](../../apps/issue-host/README.md#install-and-safe-upgrades).
