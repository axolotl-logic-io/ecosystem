# Operations

The installed runtime activates configured buddies and their task loops. Source delivery does not install, activate or deploy either application. The operator separately authorizes a drained cutover.

## Programs

Programs run from `$ISSUE_PIPELINE_ROOT`, which defaults to `~/.pi/agent/issue-pipeline`.

| Program | Purpose |
| --- | --- |
| `buddy.mjs` | Validate a buddy file or activate its task loops |
| `database.mjs` | Private bounded PostgreSQL coordination transport; no migration or activation |
| `ops.mjs` | Guarded deterministic operations through framed JSON requests |
| `shell-supervisor.mjs` | Run configured commands in owned process groups |
| `structured-output.mjs`, `pipeline-commit.mjs` | Schema-checked replies and scoped commits |
| `git-review.mjs` | Read-only Git queries for review sessions |
| `safe-refactor.mjs` | Explicit standalone Safe Refactor |
| `standards-upgrade.mjs` | Read-only assessment and human-start handoff |

`apps/issue-pipeline/programs.ts` is the shared build, install and syntax-check manifest. `ops.mjs` accepts only the canonical task operations that buddy actions send; it has no standalone operations.

## Configuration

Repository operator configs live in `$ISSUE_PIPELINE_ROOT/repos/`, starting from the installed `repos/example.json`. Each must pin a full commit of the repository's `.issue-pipeline.json`, the only source of project settings; candidate edits never activate their own policy. See [project settings](project-settings.md) for the split between project policy and operator identity/safety settings.

A separate private buddy JSON file defines organization scope, repository config paths, role, responsibilities, identity and access profiles. Unknown or obsolete scheduler/assignment controls are refused there. Capacity comes only from required repository `resources.modelSessions`, with no buddy-level override or default. See [buddy configuration](runtime-runs.md#buddy-configuration).

Land needs literal `permissions.land: true` in both the repository config and the Gatekeeper buddy file, plus the correct account, profile, task responsibility and current exact-binding evidence. A check pass or accepted start cannot substitute for those grants.

Obsolete fields are ignored without a warning; setting one does not make the former scheduler or assignment model active. Keys that #166 renamed, such as `mergeAccount` and `models.implementor`, are read only under their new names.

For database-backed ownership and reservations, the private repository config explicitly selects the PostgreSQL backend and a separate credential file. Omitting that selection keeps GitHub authority. Installation never switches the backend. Follow [database setup and drained cutover](database.md); mixed backends can admit duplicate owners.

## Credentials

Keep `credentialsEnvFile` outside managed worktrees, owned by the operator, with no group or other permissions. It holds `ISSUE_PIPELINE_DEV_GITHUB_TOKEN` and `ISSUE_PIPELINE_LANDING_GITHUB_TOKEN`. The old `ISSUE_PIPELINE_MERGE_GITHUB_TOKEN` key is no longer read; see [GitHub accounts](authority.md#github-accounts).

- Verify each selected account without printing its token.
- Keep the file out of web application folders and build/deploy environment files.
- Do not export GitHub credentials to models or ordinary shell children.
- Do not expect the installer to provision credentials or organization membership capability.

Model credentials belong to the separately provisioned [native runtime](runtime.md). Its policy names allowed environment variables, provider resources, runtime HOME and context expectations. Do not reuse the GitHub credential file as a model or build environment file. A same-user process is not an operating-system filesystem sandbox.

Unknown membership-reader capability is an activation blocker, not permission to change credentials, fall back to a personal account or weaken qualification.

## Validate or activate a buddy

To validate a private buddy file without activating a run:

```bash
node "$ISSUE_PIPELINE_ROOT/buddy.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is an absolute path to the operator-owned buddy JSON file. The command reports configured tasks, trusted model-session capacity and authorization digests.

To activate the accepted configuration, omit `--check`. That is a separate operator action, not a source acceptance test. Each task loop senses its own work; there is no stage cursor or caller-selected next job. See [runtime runs](runtime-runs.md).

Initial human signals are qualified issue-label application events for `start:implement` and `agents:stop`. Removing a label creates no continuation. A failed, stopped or uncertain attempt is not automatically retried.

## Install a release

Before Land, run the gate required by the effective trusted policy on the exact source candidate. For this refactor, acceptance explicitly requires all suites and independent Security before Land:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check:full
```

Run both commands at the repository root under Node 24. The fast gate alone is not full integration coverage. Retain the exact source commit, trusted-input revision, effective policy, configured target branch/commit, gate results and independent read-only Security clearance.

Before installation, confirm the delivered identity, authenticated receipt and ancestry against that evidence. Installation acceptance does not require a second suite after Land.

After source delivery, the operator separately authorizes the cutover and reviews the dry-run:

```bash
mise //apps/issue-pipeline:install:dry-run
mise //apps/issue-pipeline:install
```

The installer builds and copies managed programs, prompts and examples into the pipeline root, and agent definitions into `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` (default `~/.pi/agent`). It records the source commit in `INSTALLED.json` and backs up replaced files under `$ISSUE_PIPELINE_ROOT-backups/TIMESTAMP-install/`.

It allows uncommitted source changes and records them with `dirty: true` in `INSTALLED.json`. It refuses installation from inside the pipeline root. It does not remove files an earlier release installed, and it does not rewrite operator configs, credentials, runtime HOME, setup/teardown scripts, clones, work or recovery evidence. A source base named `main` is not deployment authority.

## Installation acceptance

Keep activation stopped until the operator accepts the installed artifacts separately from source delivery:

1. Confirm `INSTALLED.json` identifies the source commit and whether it had uncommitted changes.
2. Compare managed programs with its built artifacts and prompts/examples with reviewed source bytes.
3. Compare copied agent definitions after filling documented root placeholders.
4. Confirm backups and preservation match the reviewed dry-run.
5. Run bounded installed-CLI parsing and invalid-input checks that launch no buddy, model, server or credentialed operation.
6. Record installed identity, comparisons, exact commands/results and operator acceptance.

These checks accept installed artifacts, not runtime integration coverage. Do not run a repository suite, repair writer, fresh Security pass or second Land after source Land. Authorized evidence checkpoints and completion bookkeeping remain distinct from forbidden post-Land validation.

## Upgrade safely

1. Stop new dispatch in the old runtime.
2. Drain every old job, action, model session and resource consumer; let in-flight writes and Land settle without killing them.
3. Preserve configs, saved authority, uncertain-write journals, checkouts, patches, bundles and receipts.
4. Confirm exact-source pre-Land gate and independent Security evidence.
5. Review the installation dry-run.
6. Install the accepted source under separate operator authorization.
7. Complete installation acceptance.
8. Verify current credentials, membership capability, policy, grants and capacity before authorizing activation.

Do not run old and new runtimes together or translate old assignments or stages into accepted starts. Saved state, task records and coordination records that an earlier release wrote in another version hold their work item or scope; reconcile them explicitly. A model-session pool resize requires all its holders and consumers to drain. Never erase attempt evidence, Security rejections, landed truth or retained work to make the upgrade pass. Installing or rolling back binaries does not undo source Land.

## Recover after a source defect

Stop affected dispatch and preserve work, authoritative receipts and uncertain effects. Deliver a tested, reviewed source fix through an ordinary PR. If installed code needs replacement, complete the separately authorized upgrade above.

There is no generic restart-at-stage command or automatic continuation operation. A stopped or spent cause remains stopped or spent. Use only supported, explicitly authorized recovery for the retained action. An uncertain Land requires read-only reconciliation against its original intent, not another push, approval or writer session. Missing authority remains a hold.

## Run tests

At the repository root, `npm run check` runs both apps' fast gates. The pipeline fast gate covers source/test types, Biome, build, installer syntax and every built program's syntax. It runs no pipeline Node tests and cannot prove effect or recovery behavior. The dashboard gate includes its own tests.

`npm run check:full` runs the pipeline fast gate and every `test/**/*.test.ts` under the component, component-integration, system and acceptance folders, with file concurrency 8 and the original 180000 ms timeout, then the dashboard gate. The old unit suite was removed; new public-entrypoint tests now populate `test/`. Do not describe the suite as empty or restore historical unit tests wholesale.

Tests use temporary HOME/pipeline roots, local Git origins and fake GitHub/model processes. They must not touch real credentials, models or production data. Set disposable roots before dynamic source imports. A failed or flaky test blocks acceptance; fix its cause rather than repeating it for a pass.

Save commands, exit statuses, effective policy and source identity. Shell output filters must not hide a failed validator's status. Full suites stay explicit and pre-Land; do not run them after Land or use installation to supply missing acceptance evidence. See the [gate scope and cost report](check-gates.md).
