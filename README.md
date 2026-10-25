# Ecosystem

Ecosystem is the home of the issue pipeline, which executes caller-assigned
GitHub issues against a configured repository. Its source, operator instructions
and tests live in [`apps/issue-pipeline/`](apps/issue-pipeline/README.md).
It runs from an operator-installed copy; landing source does not install it.

The opt-in Pi [workflow dashboard](apps/workflow-dash/README.md) lives in
`apps/workflow-dash/`. It observes source records and composes editable requests;
it does not schedule work. Its installation and checks are separate from the
pipeline's.

## Check

You need Node 24 and npm, nothing else. The root `package.json` declares the
Node major in `engines`. From the root of a fresh clone:

```bash
npm ci --ignore-scripts --no-audit --no-fund   # setup
npm run check                                  # fast gate, both apps
npm run check:full                             # fast gate plus every Node test
```

The commands need no file under `$HOME` and no absolute path. The pipeline
uses the same setup and gate, from `commands` in `.issue-pipeline.json`.

The fast gate typechecks source and tests, lints, builds and checks syntax.
The pipeline's Node test suite was deleted on 2026-10-25. `check:full` still
runs every `apps/issue-pipeline/test/**/*.test.ts`, so new tests there are
picked up with no change to the scripts.
The fast gate does not run the integration/flow suite or prove runtime authority, recovery,
isolation or landing behavior. Read the
[gate scope and cost report](docs/reference/check-gates.md) before selecting
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

`main` is the only long-lived branch. The operator disabled the GitHub Check
workflow; this change does not enable it. There is no production deployment.
The operator can configure the pipeline to work on ecosystem's own issues as
well as other repositories. Issue jobs develop and review pipeline fixes; the
operator coordinates installation separately from landing them.

The [pipeline docs](docs/README.md) hold its decisions and reference. The sessions'
behavioral prompts ship with the pipeline in
`apps/issue-pipeline/prompts/`, and the caller assigns each issue, branch,
lane and stage explicitly.
