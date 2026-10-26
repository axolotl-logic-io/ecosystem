# Ecosystem docs

These docs describe the repository's practices and the issue pipeline. They are ordinary files, reviewed and landed with the code they describe. Decisions record the rules; reference pages describe how the code behaves today and how to recover when something goes wrong.

The [PR review decisions](decisions/pr-review.md) replaced the separate-duties tasks with five delivery tasks: Author, Implement, Verify, Fix and Land. The reference pages describe that source. Where the installed pipeline still behaves the old way, the page says so in a note.

## Practices

[Coding practices](coding-practices.md): the shared design, type, lint, test and secrets rules, kept identical in each repository.

[Project practices](project-practices.md): this repository's own rules, which add to the coding practices.

[Docs style guide](docs-style-guide.md): how to write these docs.

## Domain language

[Shared glossary](../GLOSSARY.md): one canonical term for each concept shared by ecosystem, dash, status-report and the test-suite assessment app.

[Domain alignment inventory](domain-alignment.md): the source cutover, historical differences and remaining acceptance gaps.

[Domain runtime contract](domain-runtime-contract.md): canonical task, signal, authorization, resource and recovery interfaces.

## Decisions

[Authority](decisions/authority.md): which GitHub accounts, records, inputs and sessions the pipeline trusts, and for what.

[Delivery](decisions/delivery.md): hardening, Security review, what an approval covers and landing order.

[Sessions](decisions/sessions.md): what the Developer owns and where role prompts come from.

[Code and tests](decisions/code-and-tests.md): what the pipeline's tests pin and how its commands clean up.

[Operations](decisions/operations.md): who assigns work, the model runtime, rate limits and checkouts.

[Buddies and tasks](decisions/buddies-and-tasks.md): the buddies and their roles, access per task, bindings and ready tasks, runs and retries, capacity, observation and standing permission.

[PR review](decisions/pr-review.md): the five delivery tasks, start labels, the Verify and Fix review loop and Land through the PR.

## Reference

[Authority](reference/authority.md): the two accounts, authority records, saved state, write authority and trusted input.

[Hardening, Verify and Fix](reference/review.md): Implement's hardening, Verify's review of the exact PR head, Fix's answers to blocking reviews and the review loop's limit.

[Check gates](reference/check-gates.md): fast and full gate scope, deadlines, evidence and the separate installation boundary.

[Sessions](reference/sessions.md): model sessions, access profiles, prompt pages and the `pipeline_commit` tool.

[Execution fencing audit](reference/execution-fencing-audit.md): the #132 audit of every credentialed and cleanup write, a dated snapshot at `ea483b5` that predates the buddy runtime.

[Runtime runs](reference/runtime-runs.md): strict buddy configuration, CLI, admission, scoped stops and canonical buddy/action observation files.

[Coordination](reference/coordination.md): task admission, fenced execution, shared resources, observations and preservation.

[Operations](reference/operations.md): programs, configuration, credentials, installing and upgrading.

[Land](reference/merge.md): Land's prerequisites, its merge of the PR pinned to the checked head, closing the issue, conflicts and read-only recovery.

[Signals](reference/signals.md): how the signal component reads control labels, accepts qualified events as records and delivers starts, reviews, stops and results.

[Task results](reference/task-results.md): exact-binding attempts, authenticated results, Verify and Land evidence, causes and holds.

[Project settings](reference/project-settings.md): tracked project policy, operator-owned controls and trusted committed revisions.

[Safe Refactor](reference/safe-refactor.md): the standalone constrained Developer task, explicit metric check, behavioral contract and write-ahead recovery.

[Standards upgrade](reference/standards-upgrade.md): the read-only, commit-bound assessment of one repository and the plan it hands to issue delivery.

[Runtime](reference/runtime.md): the native Pi runtime, context compaction and startup checks.

[Telemetry](reference/telemetry.md): run observations, context records and commit attribution.

[Checkouts](reference/checkouts.md): where clones, checkouts and run files live, and what an action preserves when it ends.

[Stops and labels](reference/stops-and-labels.md): start and stop labels, human PR reviews, durable latches, scoped interruption and unsupported continuation.
