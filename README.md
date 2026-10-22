# Ecosystem

Ecosystem is the home of the issue pipeline, which executes caller-assigned
GitHub issues against a configured repository. Its source, operator instructions
and tests live in [`apps/issue-pipeline/`](apps/issue-pipeline/README.md).
It runs from an operator-installed copy; merging source does not install it.

The opt-in Pi [workflow dashboard](apps/workflow-dash/README.md) lives in
`apps/workflow-dash/`. It observes source records and composes editable requests;
it does not schedule work. Its installation and checks are separate from the
pipeline's.

## Check

Use Node 24 and mise (the versions are declared in `mise.toml`). From the root:

```bash
npm ci
mise //apps/issue-pipeline:check
```

The check typechecks source and tests, lints, builds, checks syntax and runs the
full test suite. The dashboard's gates are separate:

```bash
npm run check --workspace @ecosystem/workflow-dash
```

The dashboard's source gates do not replace operator acceptance before
cutover. Read [AGENTS.md](AGENTS.md) before changing code.

`main` is the only long-lived branch. CI checks pull requests and pushes to
`main`; there is no production deployment. The operator can configure the pipeline to work on ecosystem's own issues as
well as other repositories. Issue jobs develop and review pipeline fixes; the
operator coordinates installation separately from merging them.

The [pipeline docs](docs/README.md) hold its decisions and reference. The sessions'
behavioral prompts ship with the pipeline in
`apps/issue-pipeline/prompts/`, and the caller assigns each issue, branch,
lane and stage explicitly.
