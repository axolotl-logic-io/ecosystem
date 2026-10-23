# Review

This page describes how a change is checked: the Reviewer's hardening, deterministic verification, the review bundle and the Security review. The rules are in [delivery decisions](../decisions/delivery.md).

## Hardening

The `review` stage runs one writable Reviewer session in phase `hardening`. It reads the trusted issue requirements, optional Author Gherkin and the Developer's draft adversarially, adds regression and edge-case tests and fixes design and correctness defects. Docs in `docs/` are part of the change it hardens.

- It commits through `pipeline_commit` (see [sessions](sessions.md)). It never synchronizes with the base; integration does that at merge.
- Its task names the actual `commands.test`, and its prompt tells it to run only targeted tests. The configured gate runs afterward, outside the session. Record its exact command and scope: the issue-pipeline repository's [fast default](check-gates.md) is not full integration coverage.
- It must not weaken requirements, assertions, coverage, check commands, lint or types to get a pass. A genuinely wrong test may be corrected with evidence. An unresolved product question goes back for an answer.
- If verification fails, check-fix sessions (also phase `hardening`) try again, up to `maxCiFixes` (default 2). After that the issue stops with `agent:stopped-check-fixes`.

When verification passes, the job pushes, saves the exact hardened revision (`state.hardened`: code head and trusted-input revision) and only then marks the draft PR ready. That checkpoint authorizes integration, not an unreviewed changed result. A restarted job with an exact matching checkpoint resumes without another writer.

A timed-out hardening session is not completed hardening. Its uncommitted work is saved as recovery evidence (see [checkouts](checkouts.md)), and the next hardening session on the same issue and branch is told where to find it.

## Deterministic verification

The `verify` op runs the repository's checks outside any model session, on an exact commit. A model's claim that checks passed is never evidence.

- The configured commands: `setup` first (a failure stops the rest), then `test`, `lint` and `typecheck`. Each is bounded by `commandTimeoutMinutes` (default 20).
- Each changed lockfile in `lockfiles` must regenerate to its committed contents.
- A change matching `migrations.pathGlobs` runs the configured migration `setup`, `up` and `down`, then `up` again when `down` is set. The first failed step fails verification.
- The job allows `verify` 120 minutes in total.

Before the code merges, verify runs in the issue's checkout and leaves it as it found it. After the merge, it runs in a clean detached checkout of the exact merge commit GitHub reports.

When `requireCi` is true (the default), CI must pass on the exact authorized head, waiting up to `ciWaitMinutes` (default 30). A PR with no required checks stops with `agent:stopped-no-ci`.

## Review bundle

`prepare-review` writes `diff.patch` and `bundle.md` for a review. The bundle starts with the exact diff, then lists the changed files in bytewise path order with their full text at the reviewed head.

- Whole-file text is included while the bundle stays within 200,000 characters. The first file that would pass that, and every later file, is listed by path only, as are deleted and binary files.
- A changed gitlink is shown as a pointer with its full SHA.
- Identical commits and diff give identical bundle bytes.

After the merge, the diff is the merge commit's change against its first parent, with the checkout detached at the merge commit.

## Security review

The merge stage runs a fresh Reviewer session in phase `security-review` before requesting a new code merge. It is read-only: no write tools, no commit authority and no token. It judges only four categories: `user-harm`, `rights`, `financial-harm` and `abuse-risk`. It is not a second design or test-adequacy review.

Security reads the exact hardened and checked candidate tree and its complete branch contribution against the observed target. A dirty checkout or a bundle prepared at another commit refuses review. The saved verdict binds the exact code and trusted-input revision, plus the configured target and its observed commit.

- A finding saves its exact receipt and stops the issue before merge.
- A code, trusted-input or target change during the session discards the verdict.
- Any changed candidate, including clean integration and conflict resolution, needs fresh checks, hardening and Security. Checked integration is not an authorization exception.
- A saved rejection of the same revision stops again without a model. Lifting a stop cannot reroll it.
- New own merges keep deterministic actual-result verification and confirmation, without a duplicate postmerge model pass.

Historical merged-result Security receipts remain history. They clear only the exact merged result they name, and never authorize a new merge. Existing historical merged runs may recover missing read-only Security after confirmed result checks. Already merged code stays merged; a historical rejection does not roll it back.

## Recover from a review stop

1. Read the stop comment and the issue's saved state. The comment names the control and the reason.
2. For `check-fixes`, read the failed check's log in the issue's run folder. Fix the cause in the change or in the repository's checks, through ordinary reviewed work; don't raise `maxCiFixes` to get a pass.
3. For a timed-out hardening session, restart `review` on the same issue, branch and lane. The new session gets the saved recovery evidence and decides what to keep.
4. For a Security stop, the candidate has not merged through this operation. Preserve its rejection and work for explicit reconciliation. Historical already-merged code may need a separate remediation issue or operator action. Lifting the label doesn't re-run Security on the same revision.
