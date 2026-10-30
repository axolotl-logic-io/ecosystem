# Agent rules

- Tasks live in root `tasks/` workspaces, shared runtime and issue adapters in
  `packages/`, one buddy in `apps/launcher/`, and fleet supervision in
  `apps/orchestrator/`. Read the relevant workspace README before changing it.
- Read [`apps/issue-host/README.md`](apps/issue-host/README.md) before changing
  issue execution or distribution. Landing activates nothing: follow
  [operations](docs/reference/operations.md) to drain, install and restart after
  landing, or provide a precise operator handoff when activation is unavailable.
- Follow [project practices](docs/project-practices.md) and, for docs, the
  [docs style guide](docs/docs-style-guide.md). Reference pages are indexed in
  [`docs/README.md`](docs/README.md).

Use Node 24 and `npm ci --ignore-scripts --no-audit --no-fund`. Run `npm run check`
for the fast default gate. `npm run check:full` includes all non-external host
and distribution tests and is required before landing the modular cutover.
mise is optional and calls the same scripts.
