# Agent rules

- `apps/issue-pipeline/` is the issue pipeline. Read its [`README.md`](apps/issue-pipeline/README.md) before changing it: landing changes nothing that runs until it's installed. The operator installs today; Lawd will once it can ([`lawd-lands-and-installs`](docs/decisions/buddies-and-tasks.md#lawd-lands-and-installs)).
- Follow the shared [coding practices](docs/coding-practices.md), this repository's [project practices](docs/project-practices.md) and, for docs, the [docs style guide](docs/docs-style-guide.md).
- The pipeline's decisions and reference are listed in [`docs/README.md`](docs/README.md).

Set up with `npm ci --ignore-scripts --no-audit --no-fund`. Run `npm run check` for the fast default gate (not full integration coverage). The expensive full suite is opt-in with `npm run check:full`; see the pipeline README before selecting it. mise is optional; its `check` tasks call the same scripts.
