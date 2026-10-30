# Operations

Source changes activate only after installation. The operator owns private
configuration, credentials, trusted policy pins and process activation.

## Distribution ownership

Root `programs.ts` declares programs, task registrations and packaged assets.
Root `build.ts` bundles them into `dist/`, independent of workspace location.
Root `install.ts` installs only the declared programs, assets, vendored compiler,
generated task manifest, README and installation record. It never removes files.
`apps/issue-pipeline` contains only forwarding source commands for older operator
automation; it is no longer an application or npm workspace.

Task definitions live in `tasks/{gherkin,implement,fix,verify,land}`. The
[issue host](../../apps/issue-host/README.md) provisions capabilities for their
GitHub adapters. The [launcher](../../apps/launcher/README.md) runs one buddy;
the [orchestrator](../../apps/orchestrator/README.md) supervises launchers.

Installed delivery programs are `orchestrator.mjs`, `launcher.mjs`, compatible
`buddy.mjs` and one executable for each task. Session support includes
`shell-supervisor.mjs`, `structured-output.mjs`, `pipeline-commit.mjs` and
`git-review.mjs`. Safe Refactor and standards upgrade retain their standalone
entrypoints, the vendored compiler and pinned Python-tool asset.

## Host paths

Set these absolute paths in the operator's service environment:

| Variable | Ownership |
| --- | --- |
| `ECOSYSTEM_INSTALL_ROOT` | Installed programs, `tasks.json`, prompts, examples and installation identity |
| `ECOSYSTEM_DATA_ROOT` | Writable clones, retained work, run observations and default model runtime HOME |
| `PI_CODING_AGENT_DIR` | Agent templates under `agents/issue-pipeline/` |

Private repository, buddy, fleet and credential files can live elsewhere. Buddy
and fleet files name them explicitly. The installer copies only nonsecret example
configurations. It does not rewrite private files, move runtime data, select
policy pins or provision a model provider, discovery cache or credentials.
See [native runtime provisioning](../../apps/issue-host/runtime/README.md).

`ISSUE_PIPELINE_ROOT` is a retained compatibility fallback for both roots. Without
it, the install root defaults to `~/.pi/agent/issue-pipeline`; the data root defaults
to the install root. New services should set both explicit roots. To preserve
existing work during migration, initially point the data root at the existing
root. Move data only after draining, preserve its permissions and update the
dashboard's `runs` setting if its location changes. The host resolves paths before
calling task or package code; neither discovers an implicit root.

## Configuration and compatibility

Use [version 2 buddy files](runtime-runs.md#launcher-buddy-file). Each buddy has
its own GitHub account, scope, tasks and private credential entry. Credentials
remain outside managed worktrees and never reach model children. The launcher
verifies the account before discovery. Repository compatibility credentials
remain necessary for shared readers and standalone tools.

The installed task CLI `TASK.mjs --config BUDDY_FILE --issue OWNER/REPO#N`
remains supported. Launcher-created children use validated `--invocation` input
and a separate credential pipe. `tasks.json` owns executable registration.

Persisted names stay unchanged: `.issue-pipeline.json`, its trusted commit pins,
operator credential keys, task comment markers, agent names and
`agents/issue-pipeline/`, and historical run formats. Renaming these is not part
of the distribution cutover. The dashboard still reads historical buddy/action
observations and current `task-run` records; its monitoring tables are unchanged.
`ops.mjs`, `database.mjs` and `recover-implement.mjs` remain retired. Never invoke
them; retire stale installed copies manually after draining.

## Drain an installed release

1. Record the running release's `INSTALLED.json`, source commit and configuration paths.
2. Signal the orchestrator or each standalone launcher with SIGTERM or SIGINT to stop discovery.
3. Wait for every launcher and task subprocess to exit. Apply `agents:stop` to cancel issue work at guarded boundaries when needed.
4. Preserve run folders, retained checkouts, recovery bundles and pushed branches.

Drain has no forced deadline or automatic kill escalation. Investigate stuck work
before replacing files. Never run old and new releases together on a repository.
Do not rewrite private configuration or installed programs while a fleet starts.

## Install a release

Run the required source gates under Node 24 before landing. Use the merged
revision, verify its recorded source checks and drain the previous release.
From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run install:dry-run
npm run install:runtime
```

The installer builds the source revision. Dry run writes only source build output,
with no installed files, agent files or backups changed. Review its complete plan.
Installation refuses symlink destinations before replacing any file, writes each
replacement atomically and backs up every replaced file, including the previous
README and `INSTALLED.json`. Backups preserve the target's absolute directory tree
under the reported backup directory. Files outside the plan are untouched.

`INSTALLED.json` records the full source commit, dirty state, time, source path,
backup directory and exact owned destination paths. A clean release must record
`dirty: false`. The ownership list describes the installed release; it never
licenses deletion of unlisted files. Installation is not a transaction across all
files: keep launchers drained if an I/O error interrupts it, then restore or
reinstall a complete verified release before activation.

Existing `mise //apps/issue-pipeline:install` and `:install:dry-run` commands still
forward to this installer. New automation should use the root npm scripts.

## Validate and restart

Validate every configured buddy before contacting GitHub:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/launcher.mjs" --config BUDDY_FILE --manifest "$ECOSYSTEM_INSTALL_ROOT/tasks.json" --check
```

`BUDDY_FILE` is an absolute path. Validation checks trusted configuration,
registrations and executables without reading tokens or contacting GitHub. Omit
`--check` to run one buddy. Verify all task executables, support assets and agent
templates are from the recorded installed release.

To supervise several buddies, write an operator-owned version 1 fleet file with
absolute `buddies`, `manifest` and `launcher` paths, then validate it:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/orchestrator.mjs" --config FLEET_FILE --check
```

`FLEET_FILE` is its absolute path. Omit `--check` to start one launcher per buddy.
The orchestrator rejects duplicate files, names and accounts before any start.
It never automatically restarts a failed launcher. Healthy siblings continue;
inspect JSON stderr reports and restart a failed buddy separately after fixing
its cause. See the [failure and shutdown contract](../../apps/orchestrator/README.md#child-failures-and-restart-policy).

Confirm the installed identity, configured accounts, manifest paths and host data
location. Check startup reports and one operator-approved task's final run record
before resuming wider discovery. If private buddy or fleet configuration is
absent, report installation separately and hand activation to the operator.

## Roll back a release

1. Drain all affected launchers and preserve new retained work and observations.
2. Restore the previous verified source checkout and its recorded configuration paths.
3. Set the same install, data and agent roots, then run that revision's installer to replace the complete distribution.
4. If source is unavailable, restore every replaced file from the recorded backup directory to its original absolute path, including the previous installation identity and agent files.
5. Retire newly introduced entrypoints using the failed release's ownership list and the previous release's manifest; never remove private configuration or retained data.
6. Validate the restored manifest and buddy or fleet configuration, then restart the previous release.

A source rollback does not undo GitHub comments, branches, reviews or merges.
Tasks recover from those artifacts. No runtime-data or monitoring-table migration
is required by this cutover. If rollback changes the data location, restore the
previous dashboard configuration as well.

## Implementation history

The modular cutover landed through [framework #273](https://github.com/axolotl-logic-io/ecosystem/pull/273),
[Gherkin #274](https://github.com/axolotl-logic-io/ecosystem/pull/274),
[shared runtime #275](https://github.com/axolotl-logic-io/ecosystem/pull/275),
[task workspaces #276](https://github.com/axolotl-logic-io/ecosystem/pull/276),
[launcher #277](https://github.com/axolotl-logic-io/ecosystem/pull/277),
[orchestrator #278](https://github.com/axolotl-logic-io/ecosystem/pull/278) and
[distribution #279](https://github.com/axolotl-logic-io/ecosystem/pull/279).
Each source merge is separate from installation and activation.
