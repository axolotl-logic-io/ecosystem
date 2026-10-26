# Check gates

The repository has a fast default gate and an explicit, expensive full gate. This page describes what each one runs, what it proves, the evidence to keep and how the gates relate to installation.

## Fast default

From the repository root, run:

```bash
npm run check
```

That runs every workspace's `check` script: the issue pipeline's, then the dashboard's. To run the pipeline's gate alone, run `npm run check --workspace @ecosystem/issue-pipeline` or `mise //apps/issue-pipeline:check`; both call the same script in `apps/issue-pipeline/package.json`. It runs:

- TypeScript checks for source, tests and the installer, under one `tsconfig.json`.
- Biome, with warnings treated as errors.
- The esbuild build.
- `node --check` on `install.ts` and on each of the ten built programs that `programs.ts` lists.

The pipeline's fast gate runs no Node tests. It doesn't prove flow behavior, authority enforcement, recovery, runtime isolation, provider or session behavior, or safe landing. Typechecking a test doesn't run its assertions. Label its result **fast default**, never full integration coverage.

The dashboard's `check` script typechecks, runs the dashboard's own Node tests and lints.

## Full gate

To select the expensive suite explicitly, run from the repository root:

```bash
npm run check:full
```

It runs the pipeline's fast gate, then this command from `apps/issue-pipeline/`, and last the dashboard's `check`:

```bash
node --test --test-concurrency=8 --test-timeout=180000 'test/{component,component-integration,system,acceptance}/**/*.test.ts'
```

`mise //apps/issue-pipeline:check:full` runs only the pipeline's part.

The suite isn't empty. `test/` holds component, component-integration and system tests, one folder per level, for buddy runs, task delivery, setup and resource release, stops, Author, Implement's hardening, Verify, Fix, Land's merge and its recovery, signals, the task ledger, project policy, model-session reservations, the distribution and standards upgrade. `npm run test:<level>` in `apps/issue-pipeline/` runs one level. They run real files, subprocesses and Git in temporary HOME and pipeline roots, against local Git origins; the buddy-flow tests run the built `buddy.mjs`. GitHub and the model are fake processes. A new `test/**/*.test.ts` file runs with no change to the scripts.

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

Installation needs the pre-Land proof that the effective policy required: the exact-source gate result and an independent, read-only pre-Land Security result. Both must bind the same full source commit, trusted-input revision, checking policy and pre-Land target branch and commit. Missing, stale or mismatched proof is a **STOP**. A fast pass alone, an invented receipt or a retrospective Security pass doesn't authorize installation.

After Land, confirm only the existing identity, receipt, ancestry, pre-Land verification and saved clearance. Run no check suite, fresh Security model, repair writer or second Land. The installer dry-run, backups, draining jobs and test consumers, a controlled cutover and [installation acceptance](operations.md#installation-acceptance) each still need separate authorization. Authorized evidence checkpoints and completion bookkeeping aren't post-Land validation.

A change to the repository's scripts doesn't rewrite an operator's `commands.test` or test wrapper. A wrapper that calls the full suite directly still runs it. To change a live wrapper, prepare the smallest proposal outside live configuration, keep its isolation and fake-transport boundaries, and get source review and operator approval first.

`.github/workflows/check.yml` defines GitHub jobs that run `mise //apps/issue-pipeline:check` and `mise //apps/workflow-dash:check`, the fast gates only. Whether GitHub runs them depends on repository settings, which this page doesn't record.
