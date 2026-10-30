# Operations

Source changes take effect only after installation. The operator owns credentials, buddy files, configuration pins and activation.

## Programs

`programs.ts` is the build and install manifest. The generated `tasks.json` registers task ids and executable paths; the launcher never infers an executable from a task name. Delivery programs are `orchestrator.mjs`, `launcher.mjs`, compatibility `buddy.mjs`, `gherkin.mjs`, `implement.mjs`, `verify.mjs`, `fix.mjs` and `land.mjs`. Session support includes `shell-supervisor.mjs`, `structured-output.mjs`, `pipeline-commit.mjs` and `git-review.mjs`. Safe Refactor and standards upgrade retain their standalone entrypoints.

`ops.mjs`, `database.mjs` and `recover-implement.mjs` are retired. The installer does not delete files outside its manifest; obsolete installed files must not be invoked.

## Configuration

Use a [version 2 buddy file](runtime-runs.md#launcher-buddy-file) with its scope, tasks, account and private credential entry. Version 1 buddy files are refused. Each buddy needs a distinct account. Repository configs still pin [project settings](project-settings.md), runtime provisioning and trusted users.

## Credentials

Keep credential files outside managed worktrees, owned by the operator and readable only by that owner. Never export their contents into model or web processes. The buddy verifies the selected token's login before use. Repository compatibility credentials remain necessary for shared readers and standalone tools; task app writes use the buddy account.

## Validate or activate a buddy

```sh
node "$ISSUE_PIPELINE_ROOT/launcher.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is the absolute path of the operator's buddy file. Omit `--check` to start it. Validation checks configuration and installed task apps, but does not verify credentials with GitHub.

## Supervise several buddies

The [orchestrator](../../apps/orchestrator/README.md) runs one standalone launcher
per configured buddy. Its strict version 1 fleet file supplies absolute paths to
`buddies`, `manifest` and `launcher`. Validate the fleet before activation:

```sh
node "$ISSUE_PIPELINE_ROOT/orchestrator.mjs" --config FLEET_FILE --check
```

`FLEET_FILE` is the private fleet file's absolute path. Omit `--check` to start.
The orchestrator validates every buddy before starting children and rejects
duplicate files, names and accounts across folders. It never automatically
restarts a failed launcher; healthy siblings continue. Inspect JSON reports on
stderr and restart a failed buddy separately after fixing its cause.

SIGTERM or SIGINT stops discovery through the launchers and waits for live tasks
to drain without a forced deadline. Apply `agents:stop` to cancel issue work at
guarded boundaries. Drain standalone copies before starting their supervised
replacements. See the [failure and shutdown contract](../../apps/orchestrator/README.md#child-failures-and-restart-policy).

## Install a release

Run the required source gates before landing. Drain old buddies and allow their in-flight work to settle before installing and restarting. Never run old and new releases on the same repository during cutover.

```sh
mise //apps/issue-host:install:dry-run
mise //apps/issue-host:install
```

The installer backs up replaced files and records `INSTALLED.json`; it does not rewrite private configs, provision credentials or select project pins.

## Installation acceptance

Validate each version 2 buddy file and confirm `tasks.json` and every registered executable are installed together. `buddy.mjs` remains compatible. See [launcher migration](../../apps/launcher/README.md#migrate-an-installation). Preserve old run folders, retained checkouts and pushed recovery branches. Monitoring tables and historical dashboard records remain available.

## Upgrade safely

Before starting launchers, replace version 1 buddy files, retire lane-slot and teardown configuration and preserve outstanding work. No database migration is required for pipeline coordination removal. After every old release is drained and replaced, the operator may delete the retired status labels listed in [stops and labels](stops-and-labels.md#upgrade-labels). Keep start, stop and running labels.

## Recover after a source defect

Preserve the failed run and retained checkout, fix the source, run its gates and land the fix. Install it before retrying with a new start label. Tasks recover from GitHub; there is no saved-stage restart or durable stop latch.

## Run tests

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run check:full
```

The fast gate checks types, lint, builds and program syntax, plus the dashboard tests. The full gate also runs pipeline tests against fake GitHub and models with real local Git. The shared database and dashboard database suites are opt-in; see [database](database.md).
