# Operations

The installed runtime activates configured buddies and their task loops. Landing a change doesn't install it; install it with the [upgrade](#upgrade-safely) steps.

## Programs

Programs run from `$ISSUE_PIPELINE_ROOT`, which defaults to `~/.pi/agent/issue-pipeline`.

| Program | Purpose |
| --- | --- |
| `buddy.mjs` | Validate a buddy file, or start a buddy: a launcher of task apps, or the earlier runtime's task loops |
| `recover-implement.mjs` | Explicit operator settlement of an interrupted pre-effect Implement; never starts work |
| `database.mjs` | Private bounded PostgreSQL coordination transport; no migration or activation |
| `ops.mjs` | Guarded deterministic operations through framed JSON requests |
| `shell-supervisor.mjs` | Run configured commands in owned process groups |
| `structured-output.mjs`, `pipeline-commit.mjs` | Schema-checked replies and scoped commits |
| `git-review.mjs` | Read-only Git queries for review sessions |
| `safe-refactor.mjs` | Explicit standalone Safe Refactor |
| `standards-upgrade.mjs` | Read-only assessment and human-start handoff |
| `land.mjs` | The [Land](merge.md) task app: merge an issue's PR and close the issue |

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

`BUDDY_FILE` is an absolute path to the operator-owned buddy JSON file. For a [launcher buddy](runtime-runs.md#launcher-buddies), the command reports its account, tasks, repositories and each task's app. For an earlier buddy, it reports configured tasks, trusted model-session capacity and authorization digests.

To start the buddy, omit `--check`. That is a separate operator action, not a source acceptance test. A launcher buddy runs a task app for each start label of its tasks it sees. An earlier buddy's task loops each sense their own work; there is no stage cursor or caller-selected next job. See [runtime runs](runtime-runs.md).

Initial human signals are qualified issue-label application events for `start:implement` and `agents:stop`. Removing a label creates no continuation. A failed, stopped or uncertain attempt is not automatically retried.

## Install a release

Before Land, run the gate required by the effective trusted policy on the exact source candidate. For this refactor, acceptance explicitly requires all suites and independent Security before Land:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check:full
```

Run both commands at the repository root under Node 24. The fast gate alone is not full integration coverage. Retain the exact source commit, trusted-input revision, effective policy, configured target branch/commit, gate results and independent read-only Security clearance.

Before installation, confirm the delivered identity, authenticated receipt and ancestry against that evidence. Installation acceptance does not require a second suite after Land.

To install the current checkout, optionally review the dry-run first:

```bash
mise //apps/issue-pipeline:install:dry-run
mise //apps/issue-pipeline:install
```

The installer builds and copies managed programs, prompts and examples into the pipeline root, and agent definitions into `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` (default `~/.pi/agent`). It records the source commit in `INSTALLED.json` and backs up replaced files under `$ISSUE_PIPELINE_ROOT-backups/TIMESTAMP-install/`.

It allows uncommitted source changes and records them with `dirty: true` in `INSTALLED.json`. It refuses installation from inside the pipeline root. It does not remove files an earlier release installed, and it does not rewrite operator configs, credentials, runtime HOME, setup/teardown scripts, clones, work or recovery evidence. A source base named `main` is not deployment authority.

## Installation acceptance

Optional: to audit an installation, check its artifacts before restarting the buddies:

1. Confirm `INSTALLED.json` identifies the source commit and whether it had uncommitted changes.
2. Compare managed programs with its built artifacts and prompts/examples with reviewed source bytes.
3. Compare copied agent definitions after filling documented root placeholders.
4. Confirm backups and preservation match the reviewed dry-run.
5. Run bounded installed-CLI parsing and invalid-input checks that launch no buddy, model, server or credentialed operation.
6. Record the installed identity and the results.

## Upgrade safely

1. Stop new dispatch in the old runtime.
2. Drain every old job, action, model session and resource consumer; let in-flight writes and Land settle without killing them.
3. Preserve configs, saved authority, uncertain-write journals, checkouts, patches, bundles and receipts.
4. Install.
5. Restart the buddies.

Do not run old and new runtimes together or translate old assignments or stages into accepted starts. Saved state, task records and coordination records that an earlier release wrote in another version hold their work item or scope; reconcile them explicitly. A model-session pool resize requires all its holders and consumers to drain. Never erase attempt evidence, Security rejections, landed truth or retained work to make the upgrade pass. Installing or rolling back binaries does not undo source Land.

## Recover after a source defect

Stop affected dispatch and preserve work, authoritative receipts and uncertain effects. Deliver a tested, reviewed source fix through an ordinary PR. If installed code needs replacement, complete the upgrade above.

There is no generic restart-at-stage command or automatic continuation operation. A stopped or spent cause remains stopped or spent. Use only supported recovery for the retained action. An uncertain Land requires read-only reconciliation against its original intent, not another push, approval or writer session. Missing authority remains a hold.

## Settle an interrupted pre-effect Implement

Use this only with every participant stopped. This command supports an original Implement action that ended before checkpoint or task effects, preserved its checkout, and retained its issue or model-session claim because settlement could not read GitHub. The one effect it accepts is the draft PR that Implement opens before its session, while that PR is still an open draft and its branch changes no files from the base. It does not support uncertain pushes, retained checkouts, Fix, Land or arbitrary claims.

First inspect the action's run record and preservation artifacts. Confirm that all participants, including other hosts and standalone operators, have stopped. The command conservatively requires every locally observed buddy to have stopped cooperatively on this host. It verifies the original authenticated attempt and confirmed issue ownership, recorded model-process exits, existing preservation artifacts and the absence of uncertain-write journals or lane consumers. A vanished process or old timestamp alone never suffices.

To preview without writing:

```bash
node "$ISSUE_PIPELINE_ROOT/recover-implement.mjs" \
  --config REPOSITORY_CONFIG --issue ISSUE_NUMBER --action ACTION_UUID \
  --reason "The interrupted work is preserved for a person."
```

`REPOSITORY_CONFIG` is the unchanged private repository config, `ISSUE_NUMBER` is the issue number, and `ACTION_UUID` is the original action's full UUID. Review the reason before publication. Add `--apply` to settle that original attempt as failed, report only its confirmed-exited model consumers done, then release its model slots and issue. The result preserves the original run and cause and posts prose on the issue. It carries no automatic-continuation grant and starts no session or GitHub business effect. Preserve its output with the cutover evidence; local run observations remain historical observations.

If any write becomes uncertain, stop and reconcile its exact intent by reading. Do not erase a journal, manufacture a replacement action or repeatedly apply the command to obtain a pass. Resume ordinary dispatch only after a complete legacy authority audit confirms that every claim and consumer drained.

## Run tests

At the repository root, `npm run check` runs both apps' fast gates. The pipeline fast gate covers source/test types, Biome, build, installer syntax and every built program's syntax. It runs no pipeline Node tests and cannot prove effect or recovery behavior. The dashboard gate includes its own tests.

`npm run check:full` runs the pipeline fast gate and every `test/**/*.test.ts` under the component, component-integration, system and acceptance folders, with file concurrency 8 and the original 180000 ms timeout, then the dashboard gate. The old unit suite was removed; new public-entrypoint tests now populate `test/`. Do not describe the suite as empty or restore historical unit tests wholesale.

Tests use temporary HOME/pipeline roots, local Git origins and fake GitHub/model processes. They must not touch real credentials, models or production data. Set disposable roots before dynamic source imports. A failed or flaky test blocks acceptance; fix its cause rather than repeating it for a pass.

Save commands, exit statuses, effective policy and source identity. Shell output filters must not hide a failed validator's status. Full suites stay explicit and pre-Land; do not run them after Land or use installation to supply missing acceptance evidence. See the [gate scope and cost report](check-gates.md).
