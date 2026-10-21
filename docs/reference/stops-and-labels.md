# Stops and labels

This page lists the pipeline's GitHub labels, what each stop means, how a stop is recorded and how to recover from one. Labels show status; they aren't authority. Saved state, exact-revision receipts and fresh write authority decide what the pipeline may do (see [authority](authority.md)).

## Status labels

| Label | Meaning |
|---|---|
| `agent:working` | The pipeline is working on the issue |
| `agent:needs-info` | The pipeline asked a question |
| `agent:split` | The issue was split into sub-issues |
| `agent:merged` | The pipeline merged the issue's change and completed it |

The pipeline creates any missing label, including every stop label, the first time it needs them. The caller selects and splits issues; these labels don't mean the pipeline discovers work. A code merge alone isn't Security clearance or completion.

## Stop labels

A failed control adds `agent:stopped-CODE` to the issue and its PR, and posts a comment naming the control, the reason and how to resume. The code comes from the first stop whose pattern matches the reason; `error` catches the rest. Read the comment and saved state, not just the label.

| Code | Control |
|---|---|
| `user-harm` | Security found harm to users, such as exposing, leaking or destroying their data |
| `rights` | Security found a violation of users' rights, such as privacy, consent or access to their own data |
| `financial-harm` | Security found financial harm to users or the operator |
| `abuse-risk` | Security found a risk of abuse, such as missing auth or rate limits, privilege escalation or injection |
| `check-fixes` | Checks still failed after `maxCiFixes` check-fix attempts |
| `no-ci` | `requireCi` is set and the PR has no required checks |
| `not-doable` | The issue can't be done as written, or the work changed nothing |
| `branch-changed` | The PR branch changed outside the pipeline |
| `conflict` | Conflict resolution ran out of `maxConflictFixes` attempts, or its result was rejected |
| `sync-limit` | The base kept moving through `maxSyncs` integrations without a merge |
| `push-rejected` | GitHub rejected a push |
| `merge-refused` | GitHub refused the merge, or the merge result couldn't be confirmed; code may already have landed |
| `job` | A legacy scheduler restarted a dying stage job too often (`maxResumes`) |
| `error` | A step, a session or a claim failed with no more specific match |

`agent:stopped-wiki-check` is legacy: the old wiki check failed. The pipeline no longer runs that check; docs are tracked Markdown reviewed with code, so it produces no new stops. The label and reason matcher remain so old stops still read.

`review-rounds` is kept only so old labels and state still read; review rounds and `maxFixRounds` were removed. Any label starting with `agent:stopped-` counts as a stop, even with an unknown code. That isn't permission to resume.

Rate limits and transient GitHub or network errors don't stop an issue. They defer it (`end: "deferred"`) without using up a fix attempt, and the caller backs off before retrying.

## How a stop is recorded

A complete stop saves the stopped state (with the stage to resume and all receipts) and clears the lease, rereads it, then removes `agent:working`, sets the stop label on the issue and PR, and closes live claims.

Before stopping, the job writes `runs/SLUG/issue-N/stop-recovery/UUID.json` (mode 0600), shared with the stop process:

- `signed-stop-confirmed`: every effect was confirmed.
- `reconciliation-required`: login, a required update or the stop process failed. The record names the issue, branch, resume stage, intended code, the original and stop failures, and which effects are confirmed or unresolved. The job reports its path.

Failure text redacts configured tokens, then keeps at most 8,192 UTF-16 code units per field. A lost response stays unresolved; it may have landed. A missing label (HTTP 404) counts as removed. If a signal interrupts the stop, the job keeps this evidence and doesn't save its older working state over a stop that may have landed.

When GitHub or login fails, labels may still show `agent:working`, or only part of the stop. A missing stop label isn't evidence of success.

## Resume a stopped issue

A new claim lifts a stop: it removes the stop labels and `agent:needs-info` from the issue and its PR, returns the issue to the stage that stopped and resets that issue's fix and sync counts. Lifting a stop supplies no missing authority. It doesn't fix checks, authorize a code push or re-run Security on a rejected revision; a saved Security rejection stops again without a model.

To recover:

1. Stop dispatching the issue.
2. Read the stop comment, the saved state and any `stop-recovery` record.
3. For `reconciliation-required`, check every unresolved effect against GitHub: saved state and its editor, lease, live claims, and issue and PR labels. Finish the stop's effects under the review/merge account. The local record is evidence, not authority.
4. Keep remote commits, local recovery files and saved receipts. Pushed commits or passing checks never stand in for missing hardening.
5. Fix the cause: through ordinary reviewed work for the change, or through config or credentials for an operator problem.
6. Restart one job on the same issue, branch and lane, at the stage saved state names. Bound your own restarts; don't loop.

For `merge-refused` after a confirmation deadline, follow [recover after a confirmation deadline](merge.md#recover-after-a-confirmation-deadline). For a Security stop, the code is already merged; remediate it with a separate issue or operator action.
