# Stops and labels

Current control signals come from qualified human issue-label application events, not label presence alone. The initial controls are `start:implement` and `agents:stop`. Accepted records, current authority and exact task results determine what may happen; status labels and process observations do not. See [signals](signals.md) and [authority](authority.md).

## Human controls

| Label application | Meaning |
|---|---|
| `start:implement` | Request one Implement attempt for the accepted trusted requirements |
| `agents:stop` | Stop the affected work item after the event and human are qualified |

The producer must satisfy current human qualification within the configured organization. PR events, Apps, bots, machine label changes and issue assignment grant no initial authority. Incomplete event pages or unreadable membership evidence hold work rather than treating a control as absent.

An accepted stop is durable after label removal. Removing or reapplying a label does not lift it. No initial continuation or retry signal is defined. An authenticated Implement attempt spends its start regardless of verdict; target movement or a new activation does not replenish it.

## Local interruption

An active action watches stop evidence. An accepted stop cooperatively interrupts model work for that issue. A newly observed, not-yet-accepted human stop or unreadable evidence can instead cause a local unknown interruption. That local hold is not a fabricated accepted human stop and is not a stop of every work item in the buddy.

Readability returning does not replay a spent start. The runtime does not kill an in-flight credentialed push, rebase or Land to simulate cancellation; uncertain effects must be read back. Failed recording preserves local evidence and can retain ownership and resource claims.

Evidence-only result, checkpoint and read-only reconciliation operations may settle original work after source loss or a stop only while current recording authorization and ownership permit it. Their trusted operation class cannot conceal a code, PR or target mutation.

## Status labels

`agent:working`, `agent:needs-info`, `agent:split` and `agent:landed` describe historical or application status. `agent:merged` is an older landed label. None activates a current task, proves a successful effect or supplies a missing result.

Old `agent:stopped-CODE` labels are not read. They neither stop nor start a task.
## Recovery boundaries

To investigate a stop or hold:

1. Stop new dispatch for the affected issue.
2. Read its accepted signals, authenticated attempts and results, checkpoints and current ownership.
3. Preserve local commits, tracked and untracked changes, bundles, patches, conflict stages and unresolved-write records.
4. Reconcile uncertain remote effects by reading the original operation's subject.
5. Establish the supported authorization before any further substantive action.

Do not clear a durable stop, erase a rejection or discard a checkout to make work look new. An expired lease or ended process grants nothing. Unsupported continuation remains unsupported; no command restarts an old saved stage.

For a possible Land, preserve the original revision, pre-Land target, policy and own proof. Follow [Land reconciliation](merge.md#uncertain-effects), not another push, writer, suite or Security session. Already-landed code stays landed while evidence is reconciled.
