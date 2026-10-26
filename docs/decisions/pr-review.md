# PR review decisions

These decisions replace the separate-duties model of issue delivery with a review loop on the pull request (PR). They describe the intended model, not installed behavior. Nothing changes until the source is landed and installed.

Autumn decided them on 2026-10-26. A section marked **Delegated** fills a gap the discussion left open; it holds until Autumn changes it.

## no-separate-duties

Decided by Autumn.

A task no longer has to be split because one side writes and the other checks. A writer task may also verify, and a verifying task may sit in the same chain as the writer it checks.

Two rules stay, because they don't depend on separate duties:

- **Authenticated records.** Only the landing account writes attempt and result records, as [authenticated-authority-records](authority.md#authenticated-authority-records) requires. This stops anyone who can comment from forging a result.
- **Two GitHub accounts.** GitHub doesn't let a PR's author approve or request changes on it. The development account opens and pushes the PR, so reviews and merges come from the landing account. See [separate-development-and-merge-accounts](authority.md#separate-development-and-merge-accounts).

This supersedes [sync-is-a-task](buddies-and-tasks.md#sync-is-a-task), [hardening-stays-independent](buddies-and-tasks.md#hardening-stays-independent), the task lists in [two-buddies](buddies-and-tasks.md#two-buddies) and [least-privilege-per-task](buddies-and-tasks.md#least-privilege-per-task), and [sequential-tasks](buddies-and-tasks.md#sequential-tasks).

## delivery-tasks

Decided by Autumn.

Issue delivery has five tasks:

| Task | Writes code | Becomes ready when | Result |
| --- | --- | --- | --- |
| Author | No | `start:author` | Gherkin requirements |
| Implement | Yes | `start:implement` | A hardened PR head |
| Verify | No | A PR head with no Verify result, or `start:verify` | A submitted review on that exact head |
| Fix | Yes | A blocking review on the current head, or Land finding a conflict | A new head that answers the review and contains the base |
| Land | Yes, the base | An approved head that is ready to merge | The PR merged and the issue closed |

```
start:author ──► Author
start:implement ──► Implement ──► Verify ◄──────────┐
start:verify ─────────────────────┘ │               │
                        approve ────┴──── request changes
                           │                  │     │
                           ▼                  ▼     │
                          Land ──conflict──► Fix ───┘
                           │
                           ▼
                merge commit, issue closed
```

Harden becomes part of Implement. Sync and Integrate become part of Fix and Verify. Complete becomes part of Land. Security becomes part of Verify.

## start-labels

Decided by Autumn.

A task gets a start label only when it can run without another task's result. Author and Implement need only an issue. Verify needs only a PR head, which may come from a person.

| Label | Requests |
| --- | --- |
| `start:author` | Author for the issue's current requirements |
| `start:implement` | Implement for the issue's current requirements |
| `start:verify` | Verify for the current head of the issue's linked PR |

Fix and Land have no label. Their prerequisites are other results, and those results wake them.

The labels go on the issue, as [label-signals](authority.md#label-signals) requires. A PR is linked to its issue by a closing reference, such as `Closes #187`, in its body. **Delegated.**

## implement-hardens

Decided by Autumn.

Implement writes the change and then hardens it before its result is recorded. The hardening pass tries to break the change and fixes what it finds. It must not weaken tests, checks, lint or types to get a pass.

The hardening pass runs in a fresh model session that doesn't read the writing session's conversation. **Delegated.** This keeps the benefit of [hardening-stays-independent](buddies-and-tasks.md#hardening-stays-independent) without a separate task.

## verify-reviews-the-pr

Decided by Autumn.

Verify checks one exact PR head and reports through a GitHub review, not only a hidden record. It runs:

- the repository's full checks (`commands.test`) on the head;
- the required CI for the head;
- the Security review of the head.

Verify posts its findings as review comments. A finding about specific lines is an inline comment on those lines. A finding about the change as a whole goes in the review body. Verify then submits the review against the head's commit, so the review binds to exactly what it checked:

- **Approve** when it finds nothing, or only nits.
- **Request changes** when it finds anything that must change.

A nit is a finding that doesn't affect behavior, safety or maintainability, such as a naming preference or comment wording. Verify still posts nits as comments, marked as non-blocking, so Fix or a person may take them up later.

A Security finding always blocks. [security-before-merge](delivery.md#security-before-merge) still holds.

## fix-answers-reviews

Decided by Autumn.

Fix is where a change goes when it doesn't pass review. It replaces "go back to Implement". Three things wake it:

- Verify's request-changes review on the current head;
- a qualified person's request-changes review on the current head;
- Land finding that the PR conflicts with its base.

A qualified person is an active member of the configured organization, as [label-signals](authority.md#label-signals) defines for labels.

Fix does two things in one run:

1. It catches the PR's head branch up with its base branch. For a PR that merges branch A into branch B, Fix merges B into A. A conflict is resolved in the same run.
2. It answers every blocking comment on the current head with a code change, and replies on each thread with what changed.

Fix merges rather than rebases. Commits that were already reviewed keep their identity, and the final merge commit keeps them in history.

When Fix pushes, the PR has a new head. Every earlier review and result was for the old head, so Verify becomes ready again. If Land had marked the PR as a draft, Fix marks it ready for review after its push. **Delegated.**

## review-loop-limit

Decided by Autumn.

An issue gets at most three Fix rounds triggered by Verify. After the third, if Verify still requests changes, the issue holds for a person.

Fix rounds triggered by a person's review or by Land's conflict don't count toward the limit, since a person or the base branch caused them, not Verify. **Delegated.**

This limit replaces the per-binding attempt ceiling for this loop. The ceiling in [runs-and-retries](buddies-and-tasks.md#runs-and-retries) still applies to each task's attempts for one binding.

## land-merges-the-pr

Decided by Autumn.

Land goes through the PR. It needs all of these for the current head:

1. An approving review from the landing account, through Verify, or from a qualified person.
2. No request-changes review from either that is still current.
3. A head that contains the base branch, so GitHub reports the PR as mergeable.
4. Green required CI.
5. The repository's `permissions.land` grant.

When all five hold, Land merges the PR with a merge commit. It passes the head commit it checked, so GitHub refuses the merge if anyone has pushed since. It then closes the issue. One Land result covers both effects.

When the PR is approved but conflicts with its base, Land marks the PR as a draft instead and records why. Fix then becomes ready.

Recovery reads the PR's merged state and the issue's state. It never merges or closes twice.

To stop the base branch moving between Land's checks and the merge, the base should require branches to be up to date before merging. GitHub then refuses a stale merge itself, and the PR goes back to Fix.

This supersedes the fast-forward Land in the [merge reference](../reference/merge.md) and the separate Completion task.

## Open questions

- **Retrying Implement.** Should `start:implement` request a new attempt after a failed Implement for the same requirements? Today [stops and labels](../reference/stops-and-labels.md) refuse that.
- **Author before Implement.** Should Implement wait while an Author attempt on the issue is unsettled, and should Author's Gherkin count toward the requirements digest?
