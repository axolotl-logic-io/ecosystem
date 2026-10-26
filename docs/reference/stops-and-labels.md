# Stops and labels

Control signals come from qualified human events, not from a label's presence alone. People control issue delivery with three start labels, one stop label and their reviews of the issue's pull request (PR). Accepted records, current authority and exact task results decide what may happen; status labels and process observations don't. See [signals](signals.md), [authority](authority.md) and [start-labels](../decisions/pr-review.md#start-labels).

**Note:** The installed pipeline accepts only `start:implement` and `agents:stop`. `start:author`, `start:verify` and review signals run only once this source is installed.

## Human controls

Every control label goes on the issue. A label on a PR grants nothing.

| Label application | Meaning |
|---|---|
| `start:author` | Request Author for the issue's current requirements |
| `start:implement` | Request one Implement attempt for the issue's current requirements |
| `start:verify` | Request Verify for the current head of the issue's linked PR |
| `agents:stop` | Stop the affected work item after the event and the person are qualified |

A task gets a start label only when it can run without another task's result. Fix and Land have no label: other results wake them. The issue's linked PR is the one PR from its branch, `agent/issue-N`. Implement opens it with a closing reference, such as `Closes #187`, in its body, so merging the PR closes the issue too.

The producer must be a qualified person: an active member of the configured organization. Apps, bots, machine label changes and issue assignment grant no authority. Incomplete event pages or unreadable membership evidence hold work rather than treating a control as absent.

## Human reviews

A qualified person's submitted review on the issue's linked PR is a signal too. It binds the head commit it was submitted against.

| Review on the current head | Effect |
|---|---|
| `CHANGES_REQUESTED` | Wakes [Fix](review.md#fix); the round doesn't count toward Verify's loop limit |
| `APPROVED` | Counts as an approval for [Land](merge.md#land-prerequisites) |

A comment-only or dismissed review binds nothing. A review of an earlier head doesn't count for the current one. The landing account's reviews are Verify's results, never human signals. The development account can't review the PR, because it authored it.

## Spent starts and retries

An accepted stop is durable after label removal. Removing or reapplying a label doesn't lift it. No continuation signal is defined.

An authenticated attempt spends its start whatever its verdict. Target movement or a new activation doesn't replenish it. `start:implement` doesn't request a new attempt after a failed Implement for the same requirements; that event holds with "retrying requirements Implement already attempted is unsupported". `start:author` holds the same way for Author. Newly edited requirements need a newly accepted start. A `start:verify` binds the PR head it was accepted for; after a push, Verify waits for a new start for the new head unless the push's own result wakes it.

Whether `start:implement` should retry a failed Implement is an [open question](../decisions/pr-review.md#open-questions). So is whether Implement should wait for an unsettled Author. Until they're decided, retries stay unsupported and Implement doesn't wait for Author.

## Local interruption

An active action watches stop evidence. An accepted stop cooperatively interrupts model work for that issue. A newly observed, not-yet-accepted human stop or unreadable evidence can instead cause a local unknown interruption. That local hold isn't a fabricated accepted human stop, and it doesn't stop every work item in the buddy.

Readability returning doesn't replay a spent start. The runtime doesn't kill an in-flight credentialed push, merge, review submission or Land to simulate cancellation; uncertain effects must be read back. Failed recording preserves local evidence and can retain ownership and resource claims.

Evidence-only result, checkpoint and read-only reconciliation operations may settle original work after source loss or a stop, but only while current recording authorization and ownership permit it. Their trusted operation class can't conceal a code, PR or base mutation.

## Status labels

`agent:working`, `agent:needs-info`, `agent:split` and `agent:landed` describe historical or application status. `agent:merged` is an older landed label. None activates a task, proves a successful effect or supplies a missing result.

Old `agent:stopped-CODE` labels aren't read. They neither stop nor start a task.

## Recovery boundaries

To investigate a stop or hold:

1. Stop new dispatch for the affected issue.
2. Read its accepted signals, authenticated attempts and results, checkpoints and current ownership.
3. Preserve local commits, tracked and untracked changes, bundles, patches, conflict stages and unresolved-write records.
4. Reconcile uncertain remote effects by reading the original operation's subject.
5. Establish the supported authorization before any further substantive action.

Don't clear a durable stop, dismiss a review or discard a checkout to make work look new. An expired lease or ended process grants nothing. Unsupported continuation remains unsupported; no command restarts an old saved stage.

For a possible Land, preserve the PR, the checked head and the original attempt. Follow [Land reconciliation](merge.md#uncertain-effects), not another merge, writer or session. A merged PR stays merged while evidence is reconciled.
