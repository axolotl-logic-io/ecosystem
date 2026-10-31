# Land

Land merges the issue's pull request (PR) with a merge commit, pinned to the exact head it checked, and then closes the issue. The `land.mjs` task app runs it on the [task app framework](../domain-runtime-contract.md#task-app-contract). Only `start:land` starts it. An approved head doesn't make Land ready on its own.

A launcher buddy configured with the `land` task runs this app, `land.mjs`, when `start:land` is present. Land acts through the buddy's GitHub account.

## Land runs

The framework claims `start:land`, marks the issue `agent:land:running`, runs Land's work and posts an end comment. Land exits 0 when the run ends normally: it merged, found the PR already merged, marked a conflicting PR as a draft, lost the claim or was stopped. It exits 1 when the run fails, such as when a prerequisite is missing.

## Land prerequisites

Land finds the PR from the branch `agent/issue-N` and reads every prerequisite from GitHub on the PR's current head each time it runs. There are no task records, approval records or integration turns. The PR must be open and ready for review, and its head must have all of these:

1. An approval from Verify's account or a person with write access.
2. No standing request for changes from either.
3. Green required CI. At least one required check must report, and each one must pass or be skipped.
4. A head that contains the PR's base branch, which GitHub can merge.

A review stands on a head only when it was submitted on that head's commit, and only a reviewer's latest approval, request for changes or dismissal counts. A review of an earlier head never counts. Land counts a review only when GitHub reports that its author has write, maintain or admin permission on the repository, so Verify's account needs write access too.

If any prerequisite is missing, Land merges nothing and the run fails. Its end comment names each missing prerequisite and says to apply `start:land` again. A head that doesn't contain its base is Fix's work, so the comment names `start:fix` for it.

Land doesn't read the repository's `permissions.land` grant. GitHub's permissions on its buddy's account decide whether it can merge.

## Merge

Land merges the PR through its buddy's account, passing the head it checked:

```bash
gh pr merge PR --merge --match-head-commit HEAD
```

`PR` is the PR number and `HEAD` is the full commit Land checked. If anyone pushes after Land reads the head, GitHub refuses the merge. Land never squashes, rebases, pushes to the base or uses an admin bypass. To stop the base moving between Land's checks and its merge, require branches to be up to date before merging on the base.

After the merge, Land posts a comment that names the head and the merge commit. Then it closes the issue, unless the merge already closed it: GitHub closes the issue when the PR's body names it with a closing reference, such as `Closes #187`.

## Conflicts

An approved PR can still conflict with its base. Land then doesn't merge. It marks the PR as a draft and posts a comment naming `start:fix`. Land checks for a conflict before the other prerequisites, so a conflicting PR goes to Fix whatever its reviews and CI say. If GitHub refuses the merge because the base moved and now conflicts, Land handles it the same way.

To resolve it, apply `start:fix`; see [Fix](review.md#fix). Fix merges the base into the head, pushes and marks the PR ready for review again. A conflict doesn't count toward Verify's loop limit.

## Recovery from GitHub

Every run reads the PR's state first. If the PR is already merged, the run only closes the issue if it's still open, and posts a comment saying so. Land never merges twice.

Land settles a merge by reading the PR afterwards, whatever `gh` answered. A merge whose response was lost reads as merged, and the run goes on to close the issue. If the run fails before the issue is closed, apply `start:land` again: the next run finds the PR merged and only closes the issue.

| PR when the run starts | What Land does |
| --- | --- |
| Merged | Closes the issue if it's open; never merges |
| Open, and conflicts with its base | Marks the PR as a draft and names `start:fix` |
| Open, with a missing prerequisite | Fails, naming each missing prerequisite |
| Open, with every prerequisite | Merges at the checked head, then closes the issue if the merge didn't |
| Closed without a merge, or no PR | Fails; nothing is merged |
