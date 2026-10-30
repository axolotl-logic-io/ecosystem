# Hardening, Verify and Fix

Each task starts only from its start label. Reviews and results never launch the next task automatically.

## Hardening

Implement opens or reuses a draft PR on `agent/issue-N`, continues from pushed work and runs a writing session followed by a fresh hardening session. Hardening works from the change and trusted requirements, without the writing conversation. After it passes, Implement marks the PR ready. Failed runs retain their private checkout for recovery.

## Verify

`start:verify` starts `verify.mjs`. Verify checks the current head of the issue's PR with the configured full checks, required CI and one read-only Security review session. It submits a review through its buddy account, which must differ from the PR author's.

Nothing or only nits produces an approval. A blocking finding, failing check or Security finding produces a request for changes. Inline findings on changed lines go in review threads; general findings and lines outside the diff go in the review body. A Security finding always blocks.

### Verify task app

Verify recovers from its own account's review on the current head. If that review already exists, a rerun reports it rather than submitting another. A review of an earlier head does not count. Unreadable CI or a moving head fails the run rather than implying approval.

## Fix

`start:fix` starts `fix.mjs`. Fix merges the PR's base into its branch, never rebases, and answers unresolved blocking comments with code and replies. Resolved threads, nits and threads already answered by its own account are skipped. After pushing, it posts a comment naming `start:verify` as the next step.

### Recovery

Fix resumes from pushed commits and GitHub review threads. Failed runs keep their checkout. A competing push cannot overwrite another run's work; the losing run preserves its commits on a recovery branch or in its retained checkout.

## Loop limit

Fix permits at most three rounds triggered by Verify's request-changes reviews. It counts reviews from `verifyAccount`, defaulting to the repository's `landingAccount`. After the limit it asks a person to step in. No task ledger or retry counter is kept.

## Failure and recovery

Read the task's end comment, PR and retained checkout. Apply the start label again to retry after addressing the failure. [Land](merge.md) reads approvals and required CI directly from GitHub.
