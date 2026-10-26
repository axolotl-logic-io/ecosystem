# Land

Land delivers an approved PR head onto the configured base. It merges the item's pull request (PR) with a merge commit, pinned to the exact head it checked, and then closes the issue. One Land result covers both effects. Land is a Gatekeeper task with the lander access profile. See [land-merges-the-pr](../decisions/pr-review.md#land-merges-the-pr) and the [domain runtime contract](../domain-runtime-contract.md).

**Note:** The installed pipeline still lands with a fast-forward push and closes the issue in a separate Complete task. Nothing on this page runs until this source is installed.

## Land prerequisites

Land binds the item PR's current head as its revision, together with the trusted inputs, the policy and the observed base. It needs a passed Verify of that head whoever approves it, because Verify runs the Security review, and [security-before-merge](../decisions/delivery.md#security-before-merge) still holds. It may then act only when all five of these hold for that head:

1. An approving review from the landing account, which is that passed Verify, or from a qualified person.
2. No request-changes review from either that still stands on the head.
3. A head that contains the base branch, so GitHub reports the PR as mergeable.
4. Green required CI on exactly that head.
5. The trusted repository's explicit `permissions.land` grant.

A qualified person is an active member of the configured organization, as the [signals reference](signals.md#who-may-apply-a-control-label) defines it. A review stands on a head only when it was submitted against that head's commit. A review of an earlier head never counts. A person's approval of a head that Verify hasn't passed yet waits, and Verify's pass then wakes Land.

A pass is evidence, not permission. The Gatekeeper buddy must also have the right scope, responsibility, account and lander profile. Ownership, the action's cause, stop evidence and write fences are checked again at the merge itself. Absent, pending, failed or unreadable required CI can't authorize Land.

Land doesn't run checks, sessions or repairs. A head that is missing its base is Fix's work, and a head with no current approval is Verify's or a person's.

## The target's integration turn

A target-write reservation serializes participating Lands for one repository and literal base branch. Land takes this integration turn before it records its attempt. If it can't take the turn, it spends no attempt and makes no change.

The turn uses authenticated coordination records and create-only epoch refs. Issue execution is still required; a turn grants no issue authority. An unsettled Land keeps the turn. A process exit, an expired lease or a deleted local run directory doesn't release it.

The turn excludes only participants in this protocol. Outside accounts can still move the base. To close that gap, configure the base to require branches to be up to date before merging. GitHub then refuses a stale merge itself, and the PR goes back to Fix.

## Merge effect

The guarded `land-task` operation rechecks the binding and every prerequisite. The authenticated version 2 attempt records Land's intent before the merge. It keeps its action, buddy and cause. A later observation can't invent that intent.

The landing account merges the PR through GitHub with a merge commit, passing the head it checked:

```bash
gh pr merge PR --merge --match-head-commit HEAD
```

`PR` is the item's PR number and `HEAD` is the full commit Land checked. If anyone pushes after the check, GitHub refuses the merge. Land never squashes, rebases, pushes to the base or uses an admin bypass.

After the merge, the landing account closes the issue. A PR body that names the issue with a closing reference, such as `Closes #187`, may already have closed it; Land then reads the issue as closed and doesn't close it again.

Land passes only after fresh reads find the PR merged at exactly the checked head and the issue closed. Its receipt names the merge commit as the code it produced. The evidence holds the PR, the head, the merge commit and `issueClosed: true`, as [task results](task-results.md#verify-and-land-evidence) describes.

## Conflicts

An approved PR can still conflict with its base. Land then doesn't merge. It marks the PR as a draft, through the landing account, and records a refused result that says why. The refused result names the PR, the head and the base it conflicts with.

Land treats a head that doesn't contain the current base as a conflict too, even when GitHub reports it mergeable. It checks for a conflict before it reads CI, so an approved, conflicting PR goes to Fix whatever its CI says. A merge that GitHub refuses at the same head, because the base moved and now conflicts or is missing from the head, is handled the same way.

That result wakes [Fix](review.md#fix). Fix merges the base into the head, pushes and marks the PR ready for review again. A refused Land leaves code writable for Fix; only an unsettled or passed Land fences code writes. See [write authority](authority.md#controlled-writes).

A conflict doesn't spend Verify's loop limit. Fix rounds that Land caused don't count toward it.

## Uncertain effects

Recovery, the `land-reconcile` operation, settles the original attempt, with its original identity and binding. It reads the PR's merged state and the issue's state. It never merges or marks a draft. When the PR merged at the checked head but the issue still reads open, for example because the original close failed, it closes the issue itself, once. Nothing is ever merged or closed twice.

| PR | Issue | Settlement |
|---|---|---|
| Merged at the checked head | Closed | Passed |
| Merged at the checked head | Open | Recovery closes the issue, then passed; unknown if it still can't read the issue closed |
| An open draft at the checked head | Any state | Refused, with conflict evidence for Fix |
| Open and not a draft, closed without a merge, merged at another head, or no PR | Any state | Failed; this run merged nothing |
| Unreadable | Any state | Unknown; retain the turn |

Current recording authorization and ownership remain required. A lost response isn't permission to resend a merge or a close that GitHub may have accepted.

To investigate uncertainty, stop new dispatch for the affected issue. Preserve its attempts, results, checkpoints, coordination records, checkout and consumers. Then read the actual PR and issue on GitHub. Don't erase intent, release another invocation's turn or restart an old stage.
