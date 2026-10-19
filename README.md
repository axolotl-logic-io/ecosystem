# Ecosystem

Ecosystem is the home of the issue pipeline, which executes caller-assigned
GitHub issues against a configured repository. Its source, operator instructions
and tests live in [`apps/issue-pipeline/`](apps/issue-pipeline/README.md).
It runs from an operator-installed copy; merging source does not install it.

## Check

Use Node 24 and mise (the versions are declared in `mise.toml`). From the root:

```bash
npm ci
mise //apps/issue-pipeline:check
```

The check typechecks source and tests, lints, builds, checks syntax and runs the
full test suite. Read [AGENTS.md](AGENTS.md) before changing code.

`main` is the only long-lived branch. CI checks pull requests and pushes to
`main`; there is no production deployment. The pipeline can work on other
repositories; this checkout does not configure it to work on its own issues.

Wiki content is not included in this extraction. The pipeline's wiki links name
its new home; publication of those pages is a separate wiki-split decision.
An operator still supplies a separate, pinned wiki clone for prompt inputs.
