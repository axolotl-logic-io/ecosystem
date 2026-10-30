# Ecosystem

Ecosystem is the home of the issue pipeline. Configured buddies run tasks
against GitHub issues. Start labels launch task apps; each app claims its start and reads its prerequisites from GitHub. Its source,
operator instructions and tests live in
[`apps/issue-pipeline/`](apps/issue-pipeline/README.md).
It runs from an operator-installed copy; landing source does not install it.

The opt-in Pi [workflow dashboard](apps/workflow-dash/README.md) lives in
`apps/workflow-dash/`. It observes source records and composes editable requests;
it does not schedule work. Its installation and checks are separate from the
pipeline's.

## Shared database

`packages/db/` provides `@ecosystem/db`: a shared native PostgreSQL client,
Drizzle schema and migrations for ecosystem apps. Root Compose files separate
the persistent operational service from disposable tests. The dashboard uses independent monitoring tables, shared with Project Buddy. The issue pipeline no longer uses database coordination. Read the [database reference](docs/reference/database.md) for setup and tests.

## Check

You need Node 24, npm and Git. The root `package.json` declares the
Node major in `engines`. From the root of a fresh clone:

```bash
npm ci --ignore-scripts --no-audit --no-fund   # setup
npm run check                                  # fast gate, both apps and shared database
npm run check:full                             # fast gate plus non-external pipeline Node tests
```

The commands need no file under `$HOME` and no absolute path. The pipeline
uses the same setup and gate, from `commands` in `.issue-pipeline.json`.

The pipeline's fast gate typechecks source and tests, lints, builds and checks
syntax. Its full gate runs pipeline tests outside `test/system-integration/`, including
real public-entrypoint task apps, claims and recovery. New
test files are picked up with no change to the scripts. The fast gate does not
run that suite or prove runtime authority, recovery, isolation or landing behavior.
The separate `npm run test:database` suite requires the isolated PostgreSQL test
service and `TEST_DATABASE_URL`; see [database tests](docs/reference/database.md#test-the-database-contract).
Both default gates typecheck and lint the shared database without connecting to it.

Read the
[check gates](docs/reference/check-gates.md) before selecting
the expensive full suite. Both root scripts also run the dashboard's gates,
which you can run alone:

```bash
npm run check --workspace @ecosystem/workflow-dash
```

mise is optional. If you use it, `mise.toml` pins Node 24, and
`mise //apps/issue-pipeline:check`, `:check:full` and
`mise //apps/workflow-dash:check` call the same npm scripts. Each step list
lives only in `apps/*/package.json`. An operator's per-machine setup script in
`$ISSUE_PIPELINE_ROOT/repos/` is no longer needed once the operator config
takes `commands` from this repository's `.issue-pipeline.json`.

The dashboard's source gates do not replace operator acceptance before
cutover. Read [AGENTS.md](AGENTS.md) before changing code.

`main` is the only long-lived branch. The GitHub Check workflow defines fast
gates; source changes do not enable repository workflows or deploy either app.
The operator can configure the pipeline to work on ecosystem's own issues as
well as other repositories. Tasks develop and review pipeline fixes; the
operator coordinates installation separately from landing them.

The [pipeline docs](docs/README.md) hold its reference. The sessions'
behavioral prompts ship with the pipeline in
`apps/issue-pipeline/prompts/`. The operator configures each buddy's scope,
tasks and its own account; there is no shared stage cursor.
