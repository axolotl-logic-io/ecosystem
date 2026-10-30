# GitHub issue host

`@ecosystem/issue-host` provisions GitHub issue execution. It translates explicit
launcher invocations into trusted settings, credentialed GitHub and Git
capabilities, checkout paths and credential-free model sessions. It owns the
claim lifecycle, running labels, cooperative stop checks and final run reports.
The root [task workspaces](../../docs/README.md#task-workspaces) own domain behavior.
Tasks and shared packages import no host application and discover no buddy file
or installation root.

The [launcher](../launcher/README.md) runs one buddy and discovers start labels.
The [orchestrator](../orchestrator/README.md) supervises launchers. Each claimed
task still runs in its own subprocess. Running labels are observations, and
GitHub comments, branches, PRs and reviews remain recovery authority.

## Distribution and host paths

The repository root owns `programs.ts`, `build.ts`, `install.ts` and `dist/`.
The manifest bundles independently located apps and host bootstraps, and packages
task-owned prompts and agent templates. Installed commands remain `gherkin.mjs`,
`implement.mjs`, `fix.mjs`, `verify.mjs`, `land.mjs`, `launcher.mjs`,
`orchestrator.mjs` and compatible `buddy.mjs`. Safe Refactor and standards upgrade
retain their standalone commands and support assets.

Set `ECOSYSTEM_INSTALL_ROOT` to the absolute installed-program directory and
`ECOSYSTEM_DATA_ROOT` to the absolute operator-owned writable directory. The host
uses the latter for clones, work, observations and its default model runtime
HOME. `PI_CODING_AGENT_DIR` still names the separately installed agent directory.
No private repository, buddy, fleet or credential file is installed or rewritten.
The host resolves paths before calling package services or tasks.

For existing installations, `ISSUE_PIPELINE_ROOT` remains the fallback for both
roots; absent that variable, the install root defaults to
`~/.pi/agent/issue-pipeline` and the data root defaults to the install root.
These defaults exist only at host/CLI boundaries. Explicit settings should be
used for new deployments. Existing data does not move automatically.

See [operations](../../docs/reference/operations.md) for installation, migration,
validation, rollback and retained compatibility names. See
[native runtime provisioning](runtime/README.md) before model execution.

## Validate source

Use Node 24 and run from the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run check:full
```

The full gate is required before landing this cutover. It includes all
non-external host tests and distribution tests, with file concurrency 8 and
per-test timeout 180000 ms. See [gate scope](../../docs/reference/check-gates.md)
and [test kits](test/README.md).

`build.ts` and `install.ts` here are source compatibility commands that forward
to the repository root. The earlier `apps/issue-pipeline` source install commands
also forward there. They do not own a second distribution.
