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
Its distribution list bundles independently located apps and host bootstraps, and
packages task-owned prompts and agent templates. Installed commands are `gherkin.mjs`,
`implement.mjs`, `fix.mjs`, `verify.mjs`, `land.mjs`, `launcher.mjs` and
`orchestrator.mjs`. Safe Refactor and standards upgrade have their own standalone
commands and support assets.

Set `ECOSYSTEM_INSTALL_ROOT` to the absolute installed-program directory and
`ECOSYSTEM_DATA_ROOT` to the absolute operator-owned writable directory. The host
uses the latter for clones, work, observations and its default model runtime
HOME. Both roots are required and have no default. `PI_CODING_AGENT_DIR` names
the separately installed agent directory.
No private repository, buddy, fleet or credential file is installed or rewritten.
The host resolves paths before calling package services or tasks.

See [operations](../../docs/reference/operations.md) for installation,
validation and rollback. See
[native runtime provisioning](runtime/README.md) before model execution.

## Validate source

Use Node 24 and run from the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run check:full
```

The full gate is required before landing any change to the issue host. It includes all
non-external host tests and distribution tests, with file concurrency 8 and
per-test timeout 180000 ms. See [gate scope](../../docs/reference/check-gates.md)
and [test kits](test/README.md).
