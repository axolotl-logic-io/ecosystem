# Hardening, Verify and Fix

Three parts of issue delivery decide whether a change is good enough to land. Implement hardens its own change before it records a result. Verify checks one exact pull request (PR) head and reports through a GitHub review. Fix answers a review that blocks, or a conflict Land found. None of them is a workflow stage or grants Land permission. See [pr-review](../decisions/pr-review.md) and [task results](task-results.md).

**Note:** The installed pipeline still runs separate Harden, Sync, Integrate and Review Security tasks. Nothing on this page runs until this source is installed.

The loop between Verify and Fix looks like this:

```
Implement ──► Verify ──approve──► Land ──merge commit──► issue closed
                ▲  │                │
                │  request changes  conflict
                │  ▼                ▼
                └─ Fix ◄────────────┘
```

## Hardening

Hardening is part of Implement, not a task of its own ([implement-hardens](../decisions/pr-review.md#implement-hardens)). After the writing session, Implement starts a fresh `issue-pipeline-developer` session in phase `hardening`. That session doesn't read the writing session's conversation. It works from the revision, the trusted requirements and the checks.

The hardening session tries to break the change. It adds regression and edge-case tests, and it fixes design and correctness defects, including documentation. It must not weaken requirements, assertions, coverage, checking commands, lint or types to get a pass.

The session commits through [pipeline_commit](sessions.md#pipeline_commit). Implement then pushes the branch and opens the PR through the development account. Its passed result names the hardened head as the code it produced. A model's statement that checks passed isn't verification; Verify supplies that.

A failed or interrupted hardening session doesn't become a passed Implement. It grants no automatic check-fix loop. Preserve uncommitted work, local commits and checkpoints for authorized recovery rather than starting another session from a reset.

## Verify

Verify belongs to the Gatekeeper and uses the reader profile. It binds the item PR's current head, with its trusted inputs, policy and observed base. It becomes ready for a head that has no Verify result, or when a qualified person applies `start:verify` to the issue.

Verify runs three checks on that exact head:

- the repository's full checks, `commands.test`, in a fresh checkout of the head;
- the required CI for the head;
- the Security review of the head.

The Security review is one fresh `issue-pipeline-reviewer` session in phase `security-review`, using the `verify.md` page. It has no commit authority and no GitHub token. It covers four categories: `user-harm`, `rights`, `financial-harm` and `abuse-risk`.

Verify can't commit, rebase or push. Tracked changes that the checks leave behind fail the run, and Verify keeps the checkout and its patch rather than publishing them.

### Review comments

Verify reports its findings on the PR, not only in a hidden record:

- A finding about specific lines is an inline comment on those lines.
- A finding about the change as a whole goes in the review body. So does a finding on lines outside the PR's diff, with its `path:line`, because GitHub rejects an inline comment there.
- Every finding starts with its label: **Security (blocking)**, **Blocking** or **Nit (non-blocking)**. Fix treats a comment that starts with "Nit" or "Non-blocking" as non-blocking.

A nit is a finding that doesn't affect behavior, safety or maintainability, such as a naming preference or comment wording. Fix or a person may take it up later.

### The verdict

Verify submits its review through the landing account against the head's commit. The review then binds to exactly what Verify checked. GitHub doesn't let a PR's author approve or request changes on it, which is why the development account can't submit it.

| Findings | Review | Verdict |
|---|---|---|
| None, or only nits | `APPROVE` | `passed` |
| Anything that must change | `REQUEST_CHANGES` | `refused` |
| Any Security finding | `REQUEST_CHANGES` | `refused` |
| Verify couldn't judge the head | None | `failed` |
| The review's submission is uncertain | Unknown | `unknown` |

A Security finding always blocks, as [security-before-merge](../decisions/delivery.md#security-before-merge) requires. A failing check or red required CI is a blocking finding too.

The result's evidence records the submitted review, the counts of blocking findings and nits, and whether a Security finding was among them. See [Verify and Land evidence](task-results.md#verify-and-land-evidence).

A Verify result binds one head. A new head, from Fix or from a person's push, has no Verify result, so Verify becomes ready again. A passed Verify doesn't rerun for the same head.

## Fix

Fix belongs to the Developer and uses the writer profile. It binds the item PR's current head. It has no start label; one of these wakes it ([fix-answers-reviews](../decisions/pr-review.md#fix-answers-reviews)):

- Verify's request-changes review on the current head;
- a qualified person's request-changes review on the current head;
- Land's refused result for a PR that conflicts with its base.

Fix does two things in one run:

1. It catches the PR's head branch up with its base branch. For a PR that merges branch A into branch B, Fix merges B into A, and resolves any conflict in the same run.
2. It answers every blocking comment on the current head with a code change, and replies on each thread with what changed.

Fix merges rather than rebases. Commits that were already reviewed keep their identity, and the final merge commit keeps them in history.

Fix's session is an `issue-pipeline-developer` session in phase `fix`, using the `fix.md` page. It runs only when the merge conflicts, a request for changes stands on the head, or Verify caused the round. A Land conflict that now merges cleanly is pushed without a session.

The session stages its resolution and concludes the merge with one [pipeline_commit](sessions.md#pipeline_commit). Fix's finish step then checks the checkout is clean, has no conflict markers and contains both the old head and the base. It pushes through the development account and replies on each blocking thread through the same account. If Land had marked the PR as a draft, Fix marks it ready for review after its push.

A blocking thread is the first comment of a request-changes review that still stands on the head. Fix also gives the session each such review's body, but GitHub has no thread to reply to there, so a finding in the body gets a code change and no reply.

Fix's passed result names the new head as the code it produced. Every earlier review and result was for the old head, so Verify becomes ready for the new one.

### Conflicts

A conflict stays in the action checkout for Fix's session. The session stages its resolution, and Fix's guarded finish operation concludes the merge and pushes. A conflict that remains is kept, not sent through another session automatically.

A session failure keeps the conflict. A `cannot` reply, or a session that leaves files unmerged, saves the conflict's numbered stages and a bundle of the checkout's commits in a `merge-*` folder of the issue's recovery folder, aborts the merge and records a failure. Neither outcome grants another attempt. A changed submodule pointer isn't a text resolution, so Fix keeps its unresolved evidence rather than choose a submodule revision.

### Retained evidence

Recovery preserves staged and working-tree patches and verified Git bundles before destructive checkout cleanup. An unresolved index also records paths, stages, modes and full object IDs in `conflict-stages.json`. An unfinished merge or an uncertain checkpoint keeps the original checkout. See [checkout preservation](checkouts.md).

Read-only reconciliation settles an interrupted Fix from the remote branch, the PR and its threads. It never merges, pushes, replies, marks the PR ready, resets or cleans up.

| What it reads | Verdict |
|---|---|
| The branch is still at the bound head | `failed` |
| A new head that descends from the bound head and contains the base, a reply from this run on every blocking thread, and a PR that isn't a draft | `passed` |
| Anything else | `unknown`, held for a person |

The thread replies are the only read-only proof that the finish step completed. A Fix with no blocking threads therefore always holds for a person in recovery. Unpublished merged work stays held for explicit recovery rather than reset to the remote branch.

## Loop limit

An issue gets at most three Fix rounds that Verify triggered (`VERIFY_FIX_ROUNDS`). A Fix round counts when its cause is a refused Verify result. After the third, if Verify still requests changes, the issue holds for a person ([review-loop-limit](../decisions/pr-review.md#review-loop-limit)).

Fix rounds that a person's review or Land's conflict triggered don't count, because a person or the base branch caused them. The limit replaces the attempt ceiling for this loop only. Each task still has at most three attempts for one binding.

## Failure and recovery

To investigate a failure, read the authenticated task result and the [action observations](runtime-runs.md). Preserve the associated checkout and recovery evidence. A failed result, an unknown effect or an unanswered product question needs its supported resolution; none silently starts another model session.

A request-changes review isn't a failure. It's Verify's normal refusal, and Fix answers it. A loop held at its limit waits for a person; no label or restart lifts the limit.
