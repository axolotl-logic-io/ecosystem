# Operations

This page describes running the pipeline as an operator: its programs, configuration, credentials, installing and upgrading, and restarting after a source defect. The rules are in [operations decisions](../decisions/operations.md).

## Programs

The pipeline runs from an installed copy under `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`), never from the source folder.

| Program | Purpose |
|---|---|
| `caller-jobs.mjs` | The installed caller launcher: `start`, `status` and `wait` (see [caller](caller.md)) |
| `sweep.mjs` | The opt-in assignment sweep: starts assigned work through the caller launcher's checks (see [assignment sweep](assignment-sweep.md)) |
| `job.mjs` | Runs one stage of one issue (see [coordination](coordination.md)) |
| `ops.mjs` | Credentialed deterministic operations; reads one framed JSON request on stdin and prints one JSON reply |
| `report.mjs` | The usage report (see [telemetry](telemetry.md)) |
| `shell-supervisor.mjs` | Runs configured commands in owned process groups |
| `structured-output.mjs`, `pipeline-commit.mjs` | Schema-checked replies and the scoped commit tool |
| `git-review.mjs` | Read-only Git queries for review sessions, with no credentials |
| `orchestrate.mjs` | Retained legacy scheduler; not the caller's entry point |

## Configuration

Each repository has an operator config file in `$ISSUE_PIPELINE_ROOT/repos/`. Reproducible project settings can instead come from an explicitly pinned commit of the repository's `.issue-pipeline.json`; see [project settings](project-settings.md) for the field split, trust boundary and migration. `repos/example.json` shows the fields, and `apps/issue-pipeline/src/config-schema.ts` defines their shape and defaults. The removed `wiki` key is refused, even when false or null: remove it. Other removed fields still load with a warning naming what replaced them; legacy single-account fields are refused.

| Setting | Default |
|---|---|
| `baseBranch` | `main` |
| `takeNewWork` | `true` |
| `skipLabels` | `[]` |
| `practices` | `["AGENTS.md", "CONTRIBUTING.md"]` |
| `leaseHours` | 3 |
| `maxCiFixes`, `maxSyncs`, `maxConflictFixes` | 2, 3, 2 |
| `requireCi` | `true` |
| `ciWaitMinutes` | 30 |
| `commandTimeoutMinutes` | 20 |
| `mergeConfirmation` | 90 seconds, backoff `[1, 2, 4, 8, 10]` |
| `usageFlags` | `firstContext` 40,000, `toolOutputShare` 0.25 |

Required settings with no default include `devAccount`, `mergeAccount`, `credentialsEnvFile` and a nonempty `allowedUsers`. Set the three `models` and the [runtime](runtime.md) settings explicitly too.

## Credentials

Keep the credentials file (`credentialsEnvFile`) outside managed worktrees, owned by the operator, with no group or other permissions. It holds `ISSUE_PIPELINE_DEV_GITHUB_TOKEN` and `ISSUE_PIPELINE_MERGE_GITHUB_TOKEN` (see [authority](authority.md#two-github-accounts)).

- Verify each account's identity without printing token values.
- Keep the file out of any web app folder and out of any build or deploy `--env-file`. Pipeline build tasks don't load it.
- The installer never provisions credentials.

The model key file sets the variables that [`runtime.credentialEnv`](runtime.md) names. A [caller](caller.md) run names it by absolute path only, as `run.json`'s `modelEnvFile`. The launcher passes that path to each job's Node with `--env-file`, so only the job reads the file. The caller and the launcher never open it.

## Install a release

Install only when a change affects installed source or assets. Prompts in `apps/issue-pipeline/prompts/` and agent definitions in `agents/` are installed assets, so a prompt change takes effect only after an install. Docs changes in `docs/` need no install.

Before Land, pass the approved fast gate on a clean checkout of the exact source candidate:

```bash
npm ci --ignore-scripts --no-audit --no-fund   # at the repository root
npm run check                                  # approved exact-source fast gate before Land
```

Retain that result and independent read-only pre-Land Security clearance, bound to the same full source commit, trusted-input revision, effective current checking policy and configured pre-Land target branch/commit. Before installation, confirm the delivered identity, authenticated receipt and ancestry against that binding. Missing, stale or mismatched proof is a **STOP**, even when code has already landed. Do not invent a receipt, rerun a suite or acquire retrospective Security to fill a gap. Preserve accepted safety behavior; do not install a candidate that drops it.

The full suite is not an installation prerequisite. After source delivery, the operator separately authorizes the cutover and reviews the dry-run:

```bash
mise //apps/issue-pipeline:install:dry-run   # review what would change
mise //apps/issue-pipeline:install           # operator-authorized install
```

Install builds first, then copies programs, prompt pages and the example config into `$ISSUE_PIPELINE_ROOT`, and the agent definitions into `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` (default `~/.pi/agent`).

- It backs up every replaced or retired file under `$ISSUE_PIPELINE_ROOT-backups/TIMESTAMP-install/`.
- It records the installed commit in `INSTALLED.json`.
- It refuses uncommitted source changes unless `--allow-dirty` is given, and refuses to run from inside the pipeline root.
- It doesn't touch repository configs, setup and teardown scripts, secrets, the runtime HOME, `clones/`, `work/` or `runs/`.

Landing source changes nothing that runs. Record source delivery (the PR and its head and merge commits) and installation (the installed identity, or not applicable) separately; neither implies the other. A configured base of `main` isn't permission to deploy any repository.

## Installation acceptance

Keep dispatch stopped until the operator accepts the installed copy separately from source delivery:

1. Confirm `INSTALLED.json` records the exact accepted source commit and clean-source status.
2. Compare the managed programs with that source's built artifacts, and the copied prompts and examples with their reviewed source bytes.
3. Compare installed agent definitions with the reviewed source after filling the documented root placeholders.
4. Confirm planned retirements and retained backups match the reviewed dry-run, with operator config, runtime HOME, saved state and recovery work preserved.
5. Perform bounded installed-CLI parsing and invalid-input smoke checks that launch no job, model, server or credentialed operation.
6. Record the installed identity, managed-artifact comparisons, exact CLI commands and results, and the operator's acceptance.

These checks accept the installed artifacts and CLI boundary, not integration coverage. They do not run a repository check suite, fresh Security model, repair writer or second Land. Authorized evidence checkpoints and `finish` bookkeeping remain distinct from forbidden post-Land validation. A mismatch or failed acceptance keeps dispatch stopped; preserve the evidence for explicit operator recovery.

## Upgrade safely

1. Stop dispatching new jobs.
2. Drain every old-version job. Prefer letting an active Land finish. Confirm no old job or session remains.
3. Snapshot the installed config, saved-state evidence and recovery files.
4. Confirm the bound exact-source fast result and independent pre-Land Security described in [Install a release](#install-a-release).
5. Review the install dry-run.
6. Install the accepted source.
7. Complete [installation acceptance](#installation-acceptance).
8. Resume one explicitly assigned issue and stage at a time.

Never run old and new jobs together. Never reset branches, hardening, integration, landing-attempt evidence, Security rejections or Land receipts to make an upgrade pass. Rolling back an install doesn't undo landed code.

### Upgrade from the removed wiki flow

Before this cutover, drain all jobs that started with the wiki flow and preserve their work and receipts. Then:

1. Remove the `wiki` key from every repository config; false and null are refused too.
2. Remove `--brain-path` from launcher commands and wrappers; the argument is no longer accepted. Use the installed `$ISSUE_PIPELINE_ROOT/caller-jobs.mjs` and its installed `job.mjs`, which pins installed prompt pages.
3. Reconcile unfinished wiki-era issues explicitly. Historical state, receipts, launch records and recovery manifests remain readable; that doesn't authorize new wiki work or publication.
4. Preserve any private wiki commits, patches and bundles outside the old checkout and mirror before removing unused data. The old `work/SLUG/wiki-mirror.git`, sibling job `docs/` checkouts and private issue branches in the wiki remote are no longer maintained or cleaned up by the pipeline. Remove them only after confirming no old job uses them and all retained work is safe. Never delete the published wiki branch as routine cleanup.

The installer doesn't rewrite operator configs or remove these caches or remote branches. This cleanup is operator-owned, not an automatic migration.

## Restart after a source defect

When running the pipeline exposes a defect in its own source:

1. Stop dispatching the affected issues, and keep their work, saved state and receipts.
2. Fix the defect through an ordinary issue and PR, with tests and review.
3. Install the fixed release (see [upgrade safely](#upgrade-safely)).
4. Restart each retained issue on its original repository, branch and lane, at the stage its saved state and current inputs call for.

Lifting a stop supplies no missing authority. An uncertain Land needs read-only reconciliation, not a blind retry (see [merge](merge.md#recover-after-a-confirmation-deadline)). Never discard retained work to make an issue look new.

## Run the tests

`npm run check` is the **fast default gate**, not full integration coverage. It runs source and test type checks, Biome, the build, syntax checks for the installer and all built programs. It runs no Node tests.

`npm run check:full` explicitly opts into the full gate: the fast gate followed by every Node test in `apps/issue-pipeline/test/`, at most two test files at a time, with the original 180000 ms timeout. That suite was deleted on 2026-10-25, so it runs 0 tests until new ones are added. Do not run the full suite by default, as an installation prerequisite or after landing; explicit opt-in execution is pre-Land only. Do not run any check suite or fresh model validation after Land. Separately authorized [installation acceptance](#installation-acceptance) still applies. The [gate scope and cost report](check-gates.md) explains what the fast gate does not prove, the known cost and the remaining optimization or isolated-stage work.

Tests use temporary HOME and pipeline roots, local bare Git origins, a fake GitHub and a fake Pi; they never touch real GitHub, models or production data. A failure or flake blocks acceptance. Both run from the repository root and need only Node 24 and npm; mise is optional, and its `//apps/issue-pipeline:check` tasks call the same scripts. These repository scripts do not change live operator configuration or wrappers. Save the exact command, effective policy and source SHA with results; a wrapper that directly invokes the full suite still incurs its cost.
