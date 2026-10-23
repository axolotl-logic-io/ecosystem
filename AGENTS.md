# Agent rules

- `apps/issue-pipeline/` is the issue pipeline. Read its [`README.md`](apps/issue-pipeline/README.md) before changing it: a merge changes nothing that runs until the operator installs it.
- Follow the shared [coding practices](docs/coding-practices.md), this repository's [project practices](docs/project-practices.md) and, for docs, the [docs style guide](docs/docs-style-guide.md).
- The pipeline's decisions and reference are listed in [`docs/README.md`](docs/README.md).

Run `mise //apps/issue-pipeline:check` for the fast default gate (not full integration coverage). The expensive full suite is opt-in with `mise //apps/issue-pipeline:check:full`; see the pipeline README before selecting it.
