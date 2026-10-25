# Delivery decisions

These decisions cover how a change gets from a hardened branch onto the configured base: hardening, Security, what an approval covers and landing order. [Review](../reference/review.md), [merge](../reference/merge.md) and [sync](../reference/sync.md) reference describe the current behavior.

## security-before-merge

Run security review before the Land; security rejection must prevent landing.

## reviewer-hardens-before-merge

Before landing, a Reviewer with write access tries to break the change and fixes what it finds. It must not weaken tests, checks, lint or types to get a pass. Fixes for failing checks, lint and types must improve the design and code, not dodge the rule.

On 2026-10-22 Hardening moved to the Developer, Hippy, in a fresh session; see [hardening-stays-independent](buddies-and-tasks.md#hardening-stays-independent). The installed `review` stage still runs under the Lawd account until that change is installed.

The source can run Hippy's Hardening since #179, but only in a review job started with `--hardening-buddy hippy`. The installed caller never passes that flag, so installed jobs still harden as the Reviewer. #186 switches the caller over.

## approval-is-for-one-revision

Approval, checks and Security clearance apply to one exact code revision and one trusted-input revision. Any change after Security, including conflict resolution, needs fresh Security review.

## merge-order

Land in queue order, so slow issues don't keep losing races and re-running checks.
