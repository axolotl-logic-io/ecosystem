# Assignment sweep retirement

The assignment sweep is removed. `sweep.mjs`, its source launcher and the caller launcher it used are no longer distributed. Assignment events do not grant a buddy work, select a task or supply a continuation signal.

## Configure current work

A trusted buddy file defines scope, role, identity, responsibilities and standing permissions. Qualified issue-label events provide initial human signals. Authenticated task results drive later readiness. Each effect still needs its current task prerequisites, source authority, stop clearance and fenced ownership.

See [buddy configuration](runtime-runs.md#buddy-configuration) and [coordination](coordination.md). Repository `resources.modelSessions` replaces scheduler stage caps; the runtime does not infer capacity from old jobs or assignments.

## Preserve historical work

Historical assignment, hold, run and saved-state records remain evidence. Do not reinterpret them as accepted starts or discard their checkouts, patches, commits, receipts or resource consumers.

Before a separately authorized installation, stop old dispatch, drain every old job and consumer, and preserve or reconcile retained work. Do not run the old sweep alongside buddy runs. The installer does not migrate operator configs or grant permission to resume work; see [upgrade safely](operations.md#upgrade-safely).

## Read the former implementation

The removed implementation and its old scenario descriptions remain in Git history. They describe historical behavior, not a supported launch interface or current acceptance evidence. There is no permanent assignment adapter or automatic assignment-withdrawal restart.
