# Delivery decisions

These decisions cover how a change gets from a hardened branch onto the configured base: hardening, Security, what an approval covers and merge order. [Review](../reference/review.md), [merge](../reference/merge.md) and [sync](../reference/sync.md) reference describe the current behavior.

## security-before-merge

Run security review before merge; security rejection must prevent the merge.

Not yet implemented: the Reviewer's read-only Security review runs after the code merge, on the merged result, so a rejection stops the issue but leaves the code merged.

## reviewer-hardens-before-merge

Before merge, a Reviewer with write access tries to break the change and fixes what it finds. It must not weaken tests, checks, lint or types to get a pass. Fixes for failing checks, lint and types must improve the design and code, not dodge the rule.

## approval-is-for-one-revision

Approval, checks and Security clearance apply to one exact code revision and one trusted-input revision. Any change after Security, including conflict resolution, needs fresh Security review.

Not yet implemented: the Reviewer's own checked integration changes (final synchronization, conflict resolutions and check fixes) can still merge without a fresh Security review.

## merge-order

Merge in queue order, so slow issues don't keep losing races and re-running checks.
