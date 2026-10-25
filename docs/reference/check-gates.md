# Check gates

The issue-pipeline repository has a fast default gate and an explicit, expensive full gate. This split follows the updated 2026-10-22 requirements in [issue #178](https://github.com/axolotl-logic-io/ecosystem/issues/178). Those requirements supersede the earlier request to repeat full-suite profiling and agree on a full-suite time target. The change isolates expensive work; it does not make that work faster or claim a new full-suite timing.

## Fast default

From the repository root, run:

```bash
npm run check
```

That runs this gate and then the dashboard's. `npm run check --workspace @ecosystem/issue-pipeline` runs this gate alone, and `mise //apps/issue-pipeline:check` calls the same script. The script, in `apps/issue-pipeline/package.json`, runs:

- TypeScript checks for source, tests and the installer, all TypeScript under one `tsconfig.json`.
- Biome with the existing lint policy.
- The esbuild build.
- Node syntax validation for `install.ts` and all nine built programs, including `structured-output.mjs`.
It runs no Node tests. The artifact guards (`test/build.test.ts`) and check-task regressions (`test/check-task.test.ts`) it used to run were deleted with the rest of the suite on 2026-10-25. It does **not** prove integration/flow behavior, authority enforcement, retry/recovery, runtime isolation, provider/session behavior or safe landing. Typechecking the test files does not execute their assertions. Label its result **fast default**, never full integration coverage.

## Explicit full gate

Only when the expensive suite is explicitly selected, run:

```bash
npm run check:full
```

The script runs the fast gate, then the original command from `apps/issue-pipeline/`, and last the dashboard's gates. `mise //apps/issue-pipeline:check:full` calls the issue pipeline's part alone:

```bash
node --test --test-concurrency=2 --test-timeout=180000 'test/**/*.test.ts'
```

The glob is the original one with `.test.ts` in place of `.test.mjs` (#152); the script runs the fast gate first, as the task's dependency did. The whole suite was deleted on 2026-10-25, so the glob matches nothing and `node --test` passes with 0 tests. A new `test/**/*.test.ts` file runs here with no change to the scripts. Test files are still typechecked and linted like source.

Concurrency 2 and timeout 180000 ms remain intact. This script builds its prerequisites through the fast gate and remains runnable on its own. Do not select it by default, as an installation prerequisite or after landing. Explicit opt-in execution is pre-Land only.

## Installation prerequisite

Operator-authorized installation requires the approved exact-source fast result plus independent read-only pre-Land Security, not the full suite. Both must bind the same full source commit, trusted-input revision, effective current checking policy and configured pre-Land target branch/commit. Confirm the delivered identity, authenticated receipt and ancestry against that binding. Missing, stale or mismatched pre-Land proof is a **STOP**; neither a fast pass alone, an invented receipt nor retrospective Security authorizes installation.

After Land, confirm only existing exact identity, receipt, ancestry, pre-Land verification and saved clearance. Run no check suite, fresh Security model, repair writer or second Land. Separately authorized installer dry-run, backups, job and test-consumer drain, controlled cutover and [managed-artifact/installed-CLI acceptance](operations.md#installation-acceptance) remain required. Authorized evidence checkpoints and `finish` bookkeeping are not post-Land validation suites. Source preparation alone authorizes none of these actions.

## Observed cost and remaining work

The trusted issue records these historical observations, not measurements made by the fast gate:

| Evidence | Reported cost | Limits of the evidence |
| --- | --- | --- |
| Original Check workflow observations | 19–29 minutes, setup about 10 seconds | Runs predate the gate split; this is not a current benchmark. |
| Local `rename-gate.log`, 2026-10-22 | About 1850 seconds summed reported test time; 991 seconds wall time; slowest tests 21–35 seconds | Summed concurrent test durations are not wall time or a subprocess profile. |
| Retained log cited by the collaborator's updated requirements, source `81a5cc4` | 1381 tests; 962987.842625 ms (about 16 minutes 3 seconds) | The collaborator supplied this observation. This report does not claim a new run or independent inspection of that log. |

The old default directly selected every Node test after typecheck, lint, build and syntax checks. That suite is the costly work now isolated behind `check:full`. Full-flow fixtures launch jobs, ops, fake GitHub, fake Pi and Git subprocesses. The existing task comments also record contention on a loaded 10-core host, including a 51.3-second typecheck test and stage/hook deadline failures under higher parallelism. These observations explain why concurrency remains 2; they do not establish that 2 is optimal on an idle 4-core runner.

There is no measured breakdown here assigning time to process startup, Git setup, repeated `tsc` or fake GitHub. A fixed per-guard cost is a hypothesis, not a profile. Static test/file counts, including estimates of #164's deletions, do not establish runtime savings. Do not repeat the expensive suite merely to measure it.

Remaining work needs separately authorized profiling of a slow file and a typical file, then fixture/subprocess optimization or an explicitly isolated full-suite stage. Share only immutable setup; retain independent mutable fixtures and the existing isolation/mock fences. Compare measured wall time and subprocess costs before changing parallelism. The fast default does not replace that work or set a new full-suite performance target.

## Evidence and operator boundary

For each check result, preserve:

- The exact source commit SHA and whether the checkout was dirty.
- The exact selected command and its working directory.
- The effective task/policy, including selected files, prerequisite tasks, concurrency, timeout and any configured wrapper.
- Exit status, elapsed wall time and the retained output path.
- Whether the result is fast-default, targeted or full-suite coverage.

A repository task change does not rewrite an operator's `commands.test` or wrapper. A wrapper that bypasses the check scripts and directly invokes the full suite still runs expensive checks. Before changing such a wrapper, prepare the smallest proposal outside live configuration, preserve its isolation/mock fences and obtain source-first review and operator approval. Do not modify live configuration as part of this source change.

The GitHub Check workflow was disabled by the operator, as recorded in the issue. This change does not enable it or edit the workflow. It changes no production authorization, trust, receipt, retry, provider, token, session or landing behavior. Exact pre-Land verification must follow the approved effective policy; after Land, only the existing bound proof is confirmed, without a new suite or model validation.

For #178, save the exact candidate and ask the parent before Review, Merge, installation or operator config/wrapper modification. Parent owns publication, acceptance and hold release. Preserve all historical stopped/rejected states, manifests and budgets; neither a fast pass nor a source commit grants a restart or downstream approval.
