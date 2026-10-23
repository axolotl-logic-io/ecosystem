# Ecosystem docs

These docs describe the repository's practices and the issue pipeline. They are ordinary files, reviewed and merged with the code they describe. Decisions record the rules; reference pages describe how the code behaves today and how to recover when something goes wrong.

## Proposed configuration

[Portable check configuration](proposals/check-configuration/README.md): proposed dependency preparation and fast-check configuration.

## Practices

[Coding practices](coding-practices.md): the shared design, type, lint, test and secrets rules, kept identical in each repository.

[Project practices](project-practices.md): this repository's own rules, which add to the coding practices.

[Docs style guide](docs-style-guide.md): how to write these docs.

## Domain language

[Shared glossary](../GLOSSARY.md): one canonical term for each concept shared by ecosystem, dash, status-report and the test-suite assessment app.

[Domain alignment inventory](domain-alignment.md): where current code and docs differ from the glossary, and the proposed migration.

## Decisions

[Authority](decisions/authority.md): which GitHub accounts, records, inputs and sessions the pipeline trusts, and for what.

[Delivery](decisions/delivery.md): hardening, Security review, what an approval covers and merge order.

[Sessions](decisions/sessions.md): what the Developer owns and where role prompts come from.

[Code and tests](decisions/code-and-tests.md): what the pipeline's tests pin and how its commands clean up.

[Operations](decisions/operations.md): who assigns work, the model runtime, rate limits and checkouts.

[Buddies and tasks](decisions/buddies-and-tasks.md): the buddies and their roles, access per task, bindings and ready tasks, runs and retries, capacity, observation and assignment permission.

## Reference

[Authority](reference/authority.md): the two accounts, authority records, saved state, claims, write authority and trusted input.

[Review](reference/review.md): hardening, deterministic verification, the review bundle and the Security review.

[Sessions](reference/sessions.md): stages, model roles, prompt pages and the `pipeline_commit` tool.

[Coordination](reference/coordination.md): running stage jobs, reading their results and keeping concurrent work apart.

[Caller](reference/caller.md): the prompt that makes an agent session the pipeline's caller, and its launcher.

[Operations](reference/operations.md): programs, configuration, credentials, installing and upgrading.

[Merge](reference/merge.md): merge order, the merge call, confirming the result and completion.

[Sync](reference/sync.md): integrating with the base at merge time, conflicts and their limits.

[Project settings](reference/project-settings.md): tracked project policy, operator-owned controls, trusted committed revisions and legacy migration.

[Runtime](reference/runtime.md): the native Pi runtime, context compaction and startup checks.

[Telemetry](reference/telemetry.md): usage records, local logs, commit attribution and the usage report.

[Checkouts](reference/checkouts.md): where clones, checkouts and run files live, and what a job saves when it ends.

[Stops and labels](reference/stops-and-labels.md): status and stop labels, stop records and resuming a stopped issue.
