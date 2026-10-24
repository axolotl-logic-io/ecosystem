# Agent rules

- `apps/issue-pipeline/` is the issue pipeline. Read its [`README.md`](apps/issue-pipeline/README.md) before changing it: a merge changes nothing that runs until it's installed. The operator installs today; Lawd will once it can ([`lawd-lands-and-installs`](docs/decisions/buddies-and-tasks.md#lawd-lands-and-installs)).
- Follow the shared [coding practices](docs/coding-practices.md), this repository's [project practices](docs/project-practices.md) and, for docs, the [docs style guide](docs/docs-style-guide.md).
- The pipeline's decisions and reference are listed in [`docs/README.md`](docs/README.md).

Run `mise //apps/issue-pipeline:check` for the full gate.
