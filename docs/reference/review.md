# Hardening, Verify and Fix

Three parts of issue delivery decide whether a change is good enough to land. Implement hardens its own change before it records a result. Verify checks one exact pull request (PR) head and reports through a GitHub review. Fix answers a review that blocks, or a conflict Land found. None of them is a workflow stage or grants Land permission. See [task results](task-results.md).

**Note:** The installed pipeline still runs separate Harden, Sync, Integrate and Review Security tasks. Nothing on this page runs until this source is installed.

The loop between Verify and Fix looks like this. A person applies the start label for each step; no result starts the next task:

```
Implement ──► Verify ──approve──► Land ──merge commit──► issue closed
                ▲  │                │
                │  request changes  conflict
                │  ▼                ▼
                └─ Fix ◄────────────┘
```

## Hardening

Hardening is part of Implement, not a task of its own. After the writing session, Implement starts a fresh `issue-pipeline-developer` session in phase `hardening`. That session doesn't read the writing session's conversation. It works from the revision, the trusted requirements and the checks.

The hardening session tries to break the change. It adds regression and edge-case tests, and it fixes design and correctness defects, including documentation. It must not weaken requirements, assertions, coverage, checking commands, lint or types to get a pass.

The session commits through [pipeline_commit](sessions.md#pipeline_commit). Implement opened the issue's PR as a draft, through the development account, before its writing session; it reuses an open PR from an earlier attempt. After hardening, Implement pushes the branch and marks the PR ready. Its passed result names the hardened head as the code it produced. A model's statement that checks passed isn't verification; Verify supplies that.

A failed or interrupted hardening session doesn't become a passed Implement. It grants no automatic check-fix loop. Preserve uncommitted work, local commits and checkpoints for authorized recovery rather than starting another session from a reset.

## Verify

Verify belongs to the Gatekeeper and uses the reader profile. It binds the item PR's current head, with its trusted inputs, policy and observed base. It runs only when a qualified person applies `start:verify` to the issue, and it reviews the head that is current when it runs, even if someone pushed after the label was applied.

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

A Security finding always blocks. A failing check or red required CI is a blocking finding too.

The result's evidence records the submitted review, the counts of blocking findings and nits, and whether a Security finding was among them. See [Verify and Land evidence](task-results.md#verify-and-land-evidence).

A Verify result binds one head. A new head, from Fix or from a person's push, needs a new `start:verify`. A passed or refused Verify doesn't rerun for the same head. A Verify that failed to judge the head, for example because CI turned pending, isn't retried automatically. A new `start:verify` for that head retries it.

### Verify task app

Verify is also a [task app](runtime-runs.md#task-app-runs), `verify.mjs`, built on the task app framework. Only `start:verify` starts it. A [launcher buddy](runtime-runs.md#launcher-buddies) whose tasks include `verify` launches it for each `start:verify` it sees. A buddy with a version 1 file still runs the Verify described above.

To run it by hand, run:

```bash
node "$ISSUE_PIPELINE_ROOT/verify.mjs" --config BUDDY_FILE --issue OWNER/REPO#N
```

- `BUDDY_FILE` is the absolute path of the Verify buddy's file. The app acts as the account the file names.
- `OWNER/REPO#N` is the issue.

The app's work goes like this:

1. It finds the open PR from the issue's branch, `agent/issue-N`, and notes the PR's head.
2. It runs the repository's full checks on that head, in a fresh checkout of its own.
3. It runs the Security review in one read-only `issue-pipeline-reviewer` session, as above.
4. It waits for the required CI on that head. It reads the checks again every 30 seconds, for up to the repository config's `ciWaitMinutes`.
5. It submits one review on that head through the buddy's own account, as [the verdict](#the-verdict) describes.
6. It posts a comment on the issue that links the review and names the next start label: `start:land` after an approval, or `start:fix` after a request for changes.

The review is Verify's result. The app writes no task records.

The app fails, and submits nothing, when it can't judge the head:

- The issue has no open PR.
- The buddy's account opened the PR. GitHub doesn't let a PR's author review it, so Verify needs a buddy with another account.
- The head moved before the review.
- The setup failed, or the checks left tracked files changed.
- The review session failed or changed its checkout.
- CI had no verdict within `ciWaitMinutes`.

A failed run keeps its checkout in the pipeline's job folders for a person to inspect. A run that succeeds or stops removes its checkout. The app doesn't take a lane slot, so it refuses a repository config that sets `laneSlots`.

GitHub is the app's whole record. If the buddy's account already approved or requested changes on the current head, a rerun submits no second review. It posts a comment that links the existing review instead. A review of an earlier head doesn't count, and neither does a comment-only or dismissed review.

## Fix

Fix is the `fix.mjs` [task app](runtime-runs.md#task-app-runs). Only `start:fix` starts it. A request for changes or a Land conflict never starts Fix by itself.

To run Fix by hand:

```bash
node "$ISSUE_PIPELINE_ROOT/fix.mjs" --config BUDDY_FILE --issue OWNER/REPO#N
```

`BUDDY_FILE` is the absolute path to the Fix buddy's version 2 configuration. `OWNER/REPO#N` identifies the issue. The buddy's account makes every GitHub write and authenticates every remote Git operation. Its token never reaches the model session.

Fix reads the issue branch's open PR and the latest standing review from each reviewer. It accepts requests for changes from Verify's account or someone with repository write access. The optional repository setting `verifyAccount` names Verify's account; when absent, `landingAccount` supplies it for compatibility. Configure this when Verify uses a different buddy account.

Fix opens a fresh checkout of the pushed branch and merges the PR's base into its head, never rebasing. Existing commits keep their identity. A clean merge is committed immediately. For conflicts or unanswered blocking threads, Fix starts an `issue-pipeline-developer` session with the pinned `fix.md` page. The session resolves conflicts, makes code changes, runs relevant tests and commits with [pipeline_commit](sessions.md#pipeline_commit). Verify runs the full check afterwards.

A blocking thread belongs to a standing request-changes review, is unresolved on GitHub and doesn't start with a nit or non-blocking marker. A reply from Fix's account counts as answered. A rerun skips answered threads, including after a push moved the head beyond the reviewed commit. Resolved threads and other accounts' requests are excluded. The session also receives the accepted reviews' bodies as context.

Fix validates that the session returned exactly one reply per selected comment. It concludes a staged, resolved merge if needed, requires a clean checkout and pushes without force. It posts each reply in its thread, then comments on the issue with the pushed head and `start:verify` as the next step. It never applies that label itself.

### Recovery

GitHub is the record: every rerun starts from the pushed branch and reads the reviews and thread replies again. It doesn't depend on task records, task bindings, checkpoints or saved push journals. A failed or stopped run retains its private checkout for inspection; a successful run removes it. Sessions and the dashboard's observational run record remain in the task run folder.

A non-fast-forward push fails and keeps the checkout. It never overwrites another run's commits. Preserve and reconcile unpublished work before removing retained folders. Applying `start:fix` again starts a fresh run from GitHub; it doesn't reopen a retained checkout. Repository configurations with `laneSlots` are currently refused before checkout creation.

## Loop limit

Fix counts Verify's request-changes reviews on the PR, not earlier task records. The first, second and third requests permit a Fix round. After the third, a further request ends with a comment asking a person to step in, without a session, merge or push. Reviews by other people don't increase this count. Repeating a start after a partial run doesn't consume another round.

## Failure and recovery

Read the task app's end comment and [run observation](runtime-runs.md#task-app-runs) to investigate a failure. The end comment identifies the failing lifecycle step and says how to retry. Preserve any retained checkout and its unpublished work first.

A request-changes review is Verify's normal verdict. Apply `start:fix` to answer it, then `start:verify` to review the pushed head. Neither label is applied automatically.
