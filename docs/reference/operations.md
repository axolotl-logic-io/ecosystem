# Operations

Source changes activate only after installation. The operator owns private
configuration, credentials, trusted policy pins and process activation.

## Distribution ownership

Root `programs.ts` declares the distribution list: programs and packaged assets.
Root `build.ts` bundles them into `dist/`, independent of workspace location.
Root `install.ts` installs only the declared programs, assets, vendored compiler,
README and installation record. It never removes files.

Task definitions live in `tasks/{gherkin,implement,fix,verify,land}`. The
[issue host](../../apps/issue-host/README.md) provisions capabilities for their
GitHub adapters. The [launcher](../../apps/launcher/README.md) runs one buddy;
the [orchestrator](../../apps/orchestrator/README.md) supervises launchers.

Installed delivery programs are `orchestrator.mjs`, `launcher.mjs` and one
program for each task, named `TASK.mjs` after its task. Session support includes
`shell-supervisor.mjs`, `structured-output.mjs`, `pipeline-commit.mjs` and
`git-review.mjs`. Safe Refactor and standards upgrade retain their standalone
entrypoints, the vendored compiler and pinned Python-tool asset.

## Host paths

Set these absolute paths in the operator's service environment. The install and
data roots are required and have no default. A program refuses to start, or to
reach a path under a root, when its root is unset or relative:

| Variable | Ownership |
| --- | --- |
| `ECOSYSTEM_INSTALL_ROOT` | Installed programs, prompts, examples and installation identity |
| `ECOSYSTEM_DATA_ROOT` | Writable clones, retained work, run observations and default model runtime HOME |
| `PI_CODING_AGENT_DIR` | Agent templates under `agents/issue-pipeline/` |

Private repository, buddy, fleet and credential files can live elsewhere. Buddy
and fleet files name them explicitly. The installer copies only nonsecret example
configurations. It does not rewrite private files, move runtime data, select
policy pins or provision a model provider, discovery cache or credentials.
See [native runtime provisioning](../../apps/issue-host/runtime/README.md).

The two roots can name the same directory. The orchestrator passes its install
root to each launcher, and each launcher passes its environment to the task
programs it starts. The host resolves paths before calling task or package code;
neither discovers an implicit root.

## Configuration

Use [version 2 buddy files](runtime-runs.md#launcher-buddy-file). Each buddy has
its own GitHub account, scope, tasks and private credential entry. Credentials
remain outside managed worktrees and never reach model children. The launcher
verifies the account before discovery. A repository config's `devAccount`,
`landingAccount` and `credentialsEnvFile` serve the readers and standalone tools
that [authority](authority.md) lists.

The launcher runs task `TASK` as `TASK.mjs --invocation` in the install root,
and accepts only the tasks compiled into it. The task program reads its
validated invocation from standard input and the buddy's credentials from a
separate pipe. It accepts no other arguments.

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

The installer builds the source revision. Each install builds in a private temporary directory and removes it afterward.
Concurrent installations to different destinations do not share mutable build
output. Dry run changes no source distribution, installed files, agent files or
backups. Review its complete plan.
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

## Validate and restart

Validate every configured buddy before contacting GitHub:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/launcher.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is an absolute path. Validation checks trusted configuration
and that every configured task has a trusted program in the install root, without
reading tokens or contacting GitHub. Run it with the same `ECOSYSTEM_INSTALL_ROOT`
as the service. Omit
`--check` to run one buddy. Verify all task programs, support assets and agent
templates are from the recorded installed release.

To supervise several buddies, write an operator-owned version 1 fleet file with
absolute `buddies` and `launcher` paths, then validate it:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/orchestrator.mjs" --config FLEET_FILE --check
```

`FLEET_FILE` is its absolute path. Omit `--check` to start one launcher per buddy.
The orchestrator rejects duplicate files, names, accounts and unknown fields
before any start.
It never automatically restarts a failed launcher. Healthy siblings continue;
inspect JSON stderr reports and restart a failed buddy separately after fixing
its cause. See the [failure and shutdown contract](../../apps/orchestrator/README.md#child-failures-and-restart-policy).

Confirm the installed identity, configured accounts, install root and host data
location. Check startup reports and one operator-approved task's final run record
before resuming wider discovery. If private buddy or fleet configuration is
absent, report installation separately and hand activation to the operator.

## Roll back a release

1. Drain all affected launchers and preserve new retained work and observations.
2. Restore the previous verified source checkout and its recorded configuration paths.
3. Set the same install, data and agent roots, then run that revision's installer to replace the complete distribution.
4. If source is unavailable, restore every replaced file from the recorded backup directory to its original absolute path, including the previous installation identity and agent files.
5. Retire newly introduced entrypoints: remove files that the failed release's `INSTALLED.json` ownership list names and the restored release's ownership list doesn't. Never remove private configuration or retained data.
6. Validate the restored buddy or fleet configuration with the restored release's launcher and orchestrator, then restart the previous release.

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
