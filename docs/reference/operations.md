# Operations

This page describes running the pipeline as an operator: its programs, configuration, credentials, installing and upgrading, and restarting after a source defect. The rules are in [operations decisions](../decisions/operations.md).

## Programs

The pipeline runs from an installed copy under `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`), never from the source folder.

| Program | Purpose |
|---|---|
| `job.mjs` | Runs one stage of one issue (see [coordination](coordination.md)) |
| `ops.mjs` | Credentialed deterministic operations; reads one framed JSON request on stdin and prints one JSON reply |
| `report.mjs` | The usage report (see [telemetry](telemetry.md)) |
| `shell-supervisor.mjs` | Runs configured commands in owned process groups |
| `structured-output.mjs`, `pipeline-commit.mjs` | Schema-checked replies and the scoped commit tool |
| `git-review.mjs` | Read-only Git queries for review sessions, with no credentials |
| `orchestrate.mjs` | Retained legacy scheduler; not the caller's entry point |

## Configuration

Each repository has a config file in `$ISSUE_PIPELINE_ROOT/repos/`. `repos/example.json` shows the fields, and `apps/issue-pipeline/src/config-schema.ts` defines their shape and defaults. Removed fields still load, with a warning naming what replaced them; legacy single-account fields are refused.

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

```bash
npm ci                                       # at the repository root
mise //apps/issue-pipeline:check             # the full gate on the exact source head
mise //apps/issue-pipeline:install:dry-run   # review what would change
mise //apps/issue-pipeline:install           # install
```

Install builds first, then copies programs, prompt pages and the example config into `$ISSUE_PIPELINE_ROOT`, and the agent definitions into `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` (default `~/.pi/agent`).

- It backs up every replaced or retired file under `$ISSUE_PIPELINE_ROOT-backups/TIMESTAMP-install/`.
- It records the installed commit in `INSTALLED.json`.
- It refuses uncommitted source changes unless `--allow-dirty` is given, and refuses to run from inside the pipeline root.
- It doesn't touch repository configs, setup and teardown scripts, secrets, the runtime HOME, `clones/`, `work/` or `runs/`.

Merging source changes nothing that runs. Record source delivery (the PR and its head and merge commits) and installation (the installed identity, or not applicable) separately; neither implies the other. A configured base of `main` isn't permission to deploy any repository.

## Upgrade safely

1. Stop dispatching new jobs.
2. Drain every old-version job. Prefer letting an active merge turn finish. Confirm no old job or session remains.
3. Snapshot the installed config, saved-state evidence and recovery files.
4. Pass the full gate on the exact source head, and review the dry-run.
5. Install.
6. Resume one explicitly assigned issue and stage at a time.

Never run old and new jobs together. Never reset branches, hardening, integration, merge-attempt evidence, Security rejections or merge receipts to make an upgrade pass. Rolling back an install doesn't undo a code merge.

## Restart after a source defect

When running the pipeline exposes a defect in its own source:

1. Stop dispatching the affected issues, and keep their work, saved state and receipts.
2. Fix the defect through an ordinary issue and PR, with tests and review.
3. Install the fixed release (see [upgrade safely](#upgrade-safely)).
4. Restart each retained issue on its original repository, branch and lane, at the stage its saved state and current inputs call for.

Lifting a stop supplies no missing authority. An uncertain merge needs read-only reconciliation, not a blind retry (see [merge](merge.md#recover-after-a-confirmation-deadline)). Never discard retained work to make an issue look new.

## Run the tests

`mise //apps/issue-pipeline:check` runs type checks, Biome, the build, syntax checks and every test, at most two test files at a time. Tests use temporary HOME and pipeline roots, local bare Git origins, a fake GitHub and a fake Pi; they never touch real GitHub, models or production data. A failure or flake blocks acceptance.
