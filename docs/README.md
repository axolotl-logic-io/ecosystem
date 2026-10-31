# Ecosystem docs

These docs describe the repository's practices and modular task execution. They are ordinary files, reviewed and landed with the code they describe. Reference pages describe how the code behaves today and how to recover when something goes wrong.

The repository root owns build and installation. The issue host provisions GitHub adapters; the launcher runs one buddy and the orchestrator supervises launchers. Tasks receive explicit validated inputs and task-specific capabilities.

Issue delivery has five tasks: Gherkin, Implement, Verify, Fix and Land.

## Practices

[Project practices](project-practices.md): the repository's design, type, lint, test and secrets rules.

[Docs style guide](docs-style-guide.md): how to write these docs.

## Domain language

[Shared glossary](../GLOSSARY.md): one canonical term for each concept shared by ecosystem and its workflow dashboard.

[Domain runtime contract](domain-runtime-contract.md): the source contract for label-started task apps: claims, running labels, stops, recovery from GitHub and results.

[Issue host](../apps/issue-host/README.md): trusted settings, credentials, lifecycle and explicit runtime paths.

[Launcher](../apps/launcher/README.md): one buddy, installed task programs and explicit subprocess invocations.

[Orchestrator](../apps/orchestrator/README.md): fleet validation, launcher supervision and drain shutdown.

## Reference

[Authority](reference/authority.md): buddy accounts, label claims and trusted input.

[Hardening, Verify and Fix](reference/review.md): Implement's hardening, Verify's review of the exact PR head, Fix's answers to blocking reviews and the review loop's limit.

[Check gates](reference/check-gates.md): fast and full gate scope, deadlines, evidence and the separate installation boundary.

[Sessions](reference/sessions.md): model sessions, access profiles, prompt pages and the `pipeline_commit` tool.

[Runtime runs](reference/runtime-runs.md): launcher configuration, CLI, label claims and task-run observations.

[Shared database](reference/database.md): PostgreSQL monitoring tables, shared Drizzle migrations and isolated tests.

[Operations](reference/operations.md): programs, configuration, credentials, installing and upgrading.

[Land](reference/merge.md): Land's prerequisites, its merge of the PR pinned to the checked head, closing the issue, conflicts and recovery from GitHub.

[Project settings](reference/project-settings.md): tracked project policy, operator-owned controls and trusted committed revisions.

[Safe Refactor](reference/safe-refactor.md): the standalone constrained Developer task, explicit metric check, behavioral contract and write-ahead recovery.

[Standards upgrade](reference/standards-upgrade.md): the read-only, commit-bound assessment of one repository and the plan it hands to issue delivery.

[Runtime](reference/runtime.md): the native Pi runtime, context compaction and startup checks.

[Telemetry](reference/telemetry.md): run observations, context records and commit attribution.

[Checkouts](reference/checkouts.md): where clones, checkouts and run files live, and what an action preserves when it ends.

[Stops and labels](reference/stops-and-labels.md): start, running and stop labels.

## Task workspaces

The [shared task runtime](../packages/task-runtime/README.md) documents service
ownership, dependency direction and host-provisioned capability interfaces.

Task-owned inputs, capabilities, outcomes and retry behavior are documented in
[Gherkin](../tasks/gherkin/README.md), [Implement](../tasks/implement/README.md),
[Fix](../tasks/fix/README.md), [Verify](../tasks/verify/README.md) and
[Land](../tasks/land/README.md).
