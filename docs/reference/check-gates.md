# Check gates

The repository has a fast default gate and an explicit, expensive full gate. This page describes what each one runs, what it proves, the evidence to keep and how the gates relate to installation.

## Fast default

From the repository root, run:

```bash
npm run check
```

That runs every workspace's `check` script, including the issue pipeline, dashboard, shared packages and root tasks. To run the pipeline's gate alone, run `npm run check --workspace @ecosystem/issue-pipeline` or `mise //apps/issue-pipeline:check`; both call the same script in `apps/issue-pipeline/package.json`. It runs:

- TypeScript checks for source, tests and the installer, under one `tsconfig.json`.
- Biome, with warnings treated as errors.
- The esbuild build.
- `node --check` on `install.ts` and on each built program that `programs.ts` lists.

The pipeline's fast gate runs no Node tests. It doesn't prove flow behavior, authority enforcement, recovery, runtime isolation, provider or session behavior, or safe landing. Typechecking a test doesn't run its assertions. Label its result **fast default**, never full integration coverage.

The dashboard's `check` script typechecks, runs the dashboard's own Node tests and lints.

## Full gate

To select the expensive suite explicitly, run from the repository root:

```bash
npm run check:full
```

It checks the orchestrator and launcher applications and the shared task runtime, task framework and database packages, runs the pipeline's fast gate, then this command from `apps/issue-pipeline/`, followed by the dashboard and all five task workspace checks:

```bash
node --test --test-concurrency=8 --test-timeout=180000 'test/{component,component-integration,system,acceptance}/**/*.test.ts'
```

`mise //apps/issue-pipeline:check:full` runs only the pipeline's part.

The suite covers framework claims and overlapping runs, launcher behavior, Gherkin, Implement and hardening, Verify, Fix, Land and recovery, project policy, standalone tools and installed artifacts. Tests run real files, subprocesses and local Git against fake GitHub and models. New test files are discovered automatically.

File concurrency stays at 8. `test/system-integration/` stays out, since it needs real credentials; run it with `npm run test:system-integration`. The per-test timeout stays at 180000 ms. Fix or remove a slow test rather than raise its deadline or move its work into a hook. A failure or flake blocks acceptance; fix its cause instead of rerunning for a pass.

## Gate selection

The effective trusted checking policy decides which gate a revision needs before Land. The [pipeline README](../../apps/issue-pipeline/README.md#install-and-safe-upgrades) requires the full gate before Land for the current refactor. Run the full gate only when it's explicitly selected, and only before Land. Don't run it after Land or as an installation step.

## Known cost

This page records no measurement of the present suite. Earlier timing observations in [issue #178](https://github.com/axolotl-logic-io/ecosystem/issues/178) describe a suite that was later deleted, so they don't describe this one. Don't run the suite only to measure it; profiling needs separate authorization.

## Evidence for each result

For each check result, keep:

- The exact source commit SHA and whether the checkout was dirty.
- The exact command and its working directory.
- The effective policy: selected files, prerequisite tasks, concurrency, timeout and any configured wrapper.
- The exit status, wall time and the path of the retained output.
- Whether the result is fast-default, targeted or full-suite coverage.

Capture a command's exit status before any output filter, so a filter can't hide a failure.

## Installation boundary

Installation is a separate, operator-authorized action. Landing source installs nothing and changes no operator configuration, wrapper or credential.

Before installation, confirm the required source checks against the merged revision. Preserve evidence and retained work. To make the change take effect, [install it](operations.md#upgrade-safely); no source gate installs or restarts the pipeline.

A change to the repository's scripts doesn't rewrite an operator's `commands.test` or test wrapper. A wrapper that calls the full suite directly still runs it. To change a live wrapper, prepare the smallest proposal outside live configuration, keep its isolation and fake-transport boundaries, and get source review and operator approval first.

`.github/workflows/check.yml` runs on every PR and on each push to `main`. It has three results:

- `check` runs `npm run check`, the fast gate of every workspace. Branch protection on `main` requires it, and requires a PR's branch to be up to date with `main` before it merges.
- `tests` passes when every shard of the issue pipeline's Node tests passes. The tests are split by file across eight runners, so they finish in a fraction of the time one runner takes. Branch protection doesn't require `tests`; Verify runs the full gate on each head the pipeline lands.
- `database` runs `npm run test:database` against a disposable PostgreSQL service. Branch protection doesn't require it.

A newer push to a PR cancels that PR's older run.

The launcher workspace participates in both root gates. Its manifest tests use real files. Built launcher system coverage runs in the pipeline suite against fake GitHub and real task subprocesses.

The orchestrator workspace participates in both root gates. Its subprocess tests cover fleet validation, independent child failures, startup rollback and drain shutdown. Pipeline system tests cover the installed orchestrator with two real launchers and guarded task cancellation.
