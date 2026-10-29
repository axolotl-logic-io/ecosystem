# Stops and labels

Control signals come from qualified human events, not from a label's presence alone. People control issue delivery with five start labels, one stop label and their reviews of the issue's pull request (PR). Accepted records, current authority and exact task results decide what may happen; status labels and process observations don't. See [signals](signals.md) and [authority](authority.md).

**Note:** The installed pipeline accepts only `start:implement` and `agents:stop`. `start:author`, `start:verify` and review signals run only once this source is installed.

## Human controls

Every control label goes on the issue. A label on a PR grants nothing.

| Label application | Meaning |
|---|---|
| `start:author` | Request Author for the issue's current requirements |
| `start:implement` | Request one Implement attempt for the issue's current requirements |
| `start:verify` | Request Verify for the current head of the issue's linked PR |
| `start:fix` | Request Fix for the current head of the issue's linked PR |
| `start:land` | Request Land for the current head of the issue's linked PR |
| `agents:stop` | Stop the affected work item after the event and the person are qualified |

Every task runs only when a person applies its start label. No task result or PR review starts another task; each result's comment names the label to apply next. The issue's linked PR is the one PR from its branch, `agent/issue-N`. Implement opens it with a closing reference, such as `Closes #187`, in its body, so merging the PR closes the issue too.

The producer must be a qualified person: an active member of the configured organization. Apps, bots, machine label changes and issue assignment grant no authority. Incomplete event pages or unreadable membership evidence hold work rather than treating a control as absent.

## Human reviews

A qualified person's submitted review on the issue's linked PR is a signal too. It binds the head commit it was submitted against.

| Review on the current head | Effect |
|---|---|
| `CHANGES_REQUESTED` | Something a started [Fix](review.md#fix) answers |
| `APPROVED` | Counts as an approval for [Land](merge.md#land-prerequisites) |

A review requests no task. Apply `start:fix` or `start:land` to act on it.

A comment-only or dismissed review binds nothing. A review of an earlier head doesn't count for the current one. The landing account's reviews are Verify's results, never human signals. The development account can't review the PR, because it authored it.

## Spent starts and retries

An accepted stop is durable after label removal. Removing or reapplying a label doesn't lift it.

An authenticated attempt spends its start whatever its verdict. Target movement or a new activation doesn't replenish it. Newly edited requirements need a newly accepted start. A `start:verify`, `start:fix` or `start:land` requests its task on the PR's head as it is when the task runs, whether or not someone pushed after the label was applied.

To retry a task whose latest run failed, apply its start label again. Each new start event requests one new attempt, for any of the five tasks, with no attempt limit. The new attempt continues the existing work rather than starting over: it reads the earlier result, the issue's branch and PR, and the saved progress, and finishes what is unfinished. A run that is still unsettled is first settled by reading. A passed or refused run stands, and a new start for it holds.

Implement doesn't wait for an unsettled Author. See [interrupted Implement runs](task-results.md#interrupted-implement-runs).

## Completed starts

After a task confirms a passed, refused or failed result, it removes the matching start label through the landing account. Removing the label changes only its display: the accepted signal, spent attempt and result remain on GitHub. It never enables a retry. An action that never began, or whose result is uncertain, leaves the label alone. Read-only recovery can clear the original start after it confirms settlement.

Cleanup checks the current label application against the event that caused the task. It leaves other labels and any newer application observed during that check unchanged. GitHub offers no atomic event-conditional label removal, so a person can still reapply a label between the check and deletion. Its durable accepted record, if already recorded, remains valid.

An unreadable or unexplained application, a revoked writer grant or a failed deletion leaves the task result unchanged and logs a warning. Cleanup never blindly repeats a lost deletion response: a later application needs its own fresh check.

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
