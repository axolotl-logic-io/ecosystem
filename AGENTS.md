# Agent rules

- `apps/issue-pipeline/` is the issue pipeline. Read its [`README.md`](apps/issue-pipeline/README.md) before changing it: a merge changes nothing that runs until the operator installs it.
- Follow the [coding practices](docs/coding-practices.md) and, for docs, the [docs style guide](docs/docs-style-guide.md).
- The pipeline's decisions and reference are listed in [`docs/README.md`](docs/README.md).

The root and pipeline Biome configs encode the lint policy and its documented process-boundary exceptions.

Run `mise //apps/issue-pipeline:check` for the full gate.
