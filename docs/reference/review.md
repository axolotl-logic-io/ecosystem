# Harden, Integrate and Review Security

These tasks establish different results. Harden improves a revision. Integrate checks it deterministically. Review Security independently evaluates the exact checked candidate. None is a workflow stage or a substitute for Land permission. See [buddies and tasks](../decisions/buddies-and-tasks.md) and [task results](task-results.md).

## Harden

Harden belongs to the Developer buddy. It starts a fresh `issue-pipeline-developer` session in phase `hardening`, without the Implement session's conversation. It works from the revision, trusted requirements and checks. It tries to break the change, adds regression and edge-case tests, and fixes design and correctness defects, including documentation.

The session commits through [pipeline_commit](sessions.md#pipeline_commit). It never synchronizes the base; [Sync](sync.md) owns that. A revision missing the target waits for Sync before fresh Harden. The session must not weaken requirements, assertions, coverage, checking commands, lint or types to obtain a pass.

The action checkpoints and pushes its work through guarded operations. Its passed result identifies the exact attested code, trusted inputs, policy and target. Code produced by Harden is named in the receipt. A model's statement that checks passed is not deterministic verification proof; Integrate supplies that separate result.

A failed or interrupted session does not become completed Harden and grants no automatic check-fix loop. Retired `maxCiFixes` controls are not read. Preserve uncommitted work, local commits and checkpoints for authorized recovery rather than starting another session from a reset.

## Integrate

Integrate belongs to the independent Gatekeeper. It uses the reader profile, starts no model, and requires a current Harden pass for R on exact T, with R already containing T. It cannot rebase, repair code, commit or publish a branch.

The guarded `integrate-task` operation runs configured checks in a fresh detached checkout of R. Setup, test, lint, typecheck, lockfile and migration checks follow the effective policy. Each command remains bounded. The result records actual check outcomes; a model reply or successful output filter cannot replace exit status.

A check failure records failure. Tracked changes left by checks fail the run and retain their checkout and patch rather than publishing them. A changed revision, target, trusted-inputs hash or policy invalidates the result. A passed binding never reruns merely because a buddy restarts.

Record the exact gate and scope. This repository's [fast default](check-gates.md) excludes pipeline Node tests and is not full effect, recovery or authority acceptance. Typechecking a test does not execute it.

## Review Security

Review Security belongs to the Gatekeeper, with an identity and account independent from Harden. It starts one fresh `issue-pipeline-reviewer` session in phase `security-review`, without commit authority or a GitHub token. Reader tool declarations do not prove an enforced filesystem or network sandbox.

Security must inspect the exact hardened and integrated revision on the observed target. Its checkout head and tree must remain consistent with that binding before and after the session. A dirty or changed local tree cannot produce a pass for an unchanged remote commit. Code, trusted-input, target or policy changes require fresh bound prerequisites rather than copying clearance.

The verdict covers four categories: `user-harm`, `rights`, `financial-harm` and `abuse-risk`. It is not a second general design review. A finding records refusal before Land. A refused code and trusted-inputs subject remains fenced across target or policy changes; removing a label or restarting the buddy cannot reroll Security.

Security clearance alone grants no Land permission. Land also requires current Harden and Integrate results, policy-required exact-head CI, explicit repository permission and the Gatekeeper's standing grant. See [Land and Complete](merge.md).

## Failure and recovery

To investigate a failure, read the authenticated task result and [action observations](runtime-runs.md), then preserve the associated checkout and recovery evidence. A failed result, unknown effect or unanswered product question needs its supported resolution; none silently starts another model session.

A Security rejection applies to the candidate before Land. If historical code already landed without current proof, retain that fact and investigate through read-only reconciliation or separately authorized remediation. Do not run a post-Land suite or Security review to manufacture pre-Land permission.
