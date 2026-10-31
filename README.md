# Ecosystem

Ecosystem runs independent tasks against GitHub issues. Root `tasks/` workspaces
own validated inputs, task-specific capabilities, prompts and domain behavior.
`packages/task-framework` owns execution and `packages/task-runtime` owns shared
checkout, model, trusted-policy, recovery and issue-trigger services. Neither
tasks nor packages import applications, read buddy files or discover an implicit
installation root.

The [launcher](apps/launcher/README.md) runs one configured buddy. The optional
[orchestrator](apps/orchestrator/README.md) supervises several launchers. The
[issue host](apps/issue-host/README.md) provisions task capabilities and preserves
per-task subprocesses, GitHub claims, stop guards, credential-free model sessions,
pinned-head checks and recoverable work. The repository root owns the build,
installation record and distribution. Merging source activates nothing.

The [reference index](docs/README.md) documents the architecture and tasks.
[Operations](docs/reference/operations.md) covers host-owned paths, drain,
install, restart and rollback.

The separate [workflow dashboard](apps/workflow-dash/README.md) observes current
task runs and historical buddy/action records. Its monitoring database and
standalone installation remain independent of task execution.

## Check

Use Node 24, npm and Git. From a fresh clone:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run check:full
```

The fast gate checks distribution types, lint, build and program syntax, then
every workspace's gate. Workspace component tests include tasks, shared runtime,
launcher, orchestrator and dashboard behavior. The full gate additionally runs
all non-external host and distribution tests. It is required before landing the
modular distribution cutover. See [gate scope](docs/reference/check-gates.md).

The separate `npm run test:database` needs disposable PostgreSQL and
`TEST_DATABASE_URL`; see [database tests](docs/reference/database.md#test-the-database-contract).
Default source gates never connect to PostgreSQL. `packages/db` owns the shared
client, Drizzle schema and migrations; task execution uses no shared database.

## Build and install

```sh
npm run build
npm run install:dry-run
npm run install:runtime
```

`programs.ts` lists programs and assets from their owning workspaces. `build.ts`
bundles them into root `dist/`, including one program per task, prompts, agent
templates, standalone-tool assets and the vendored TypeScript compiler. The
installer replaces only installer-owned files, backs up replaced bytes and records
installed identity and ownership in `INSTALLED.json`. Drain the old release before installing.

mise is optional and pins Node 24. Read
[AGENTS.md](AGENTS.md) and the [project practices](docs/project-practices.md)
before changing code.
