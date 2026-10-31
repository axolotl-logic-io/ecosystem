# Launcher

`@ecosystem/launcher` runs one configured buddy. It owns the version 2 buddy
file, repository scope, account verification, duplicate-account protection and
start-label discovery. It runs standalone or under the [orchestrator](../orchestrator/README.md), which supervises one launcher process per buddy. Task definitions live in
root `tasks/` workspaces and receive explicit validated inputs and task-specific
capabilities from their bootstrap.

## Run a buddy

After installing the release, validate a buddy and its task programs:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/launcher.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is an absolute path to an operator-owned version 2 buddy file.
Omit `--check` to run it. See the [buddy file reference](../../docs/reference/runtime-runs.md#launcher-buddy-file).

The launcher finds task programs in the install root that `ECOSYSTEM_INSTALL_ROOT`
names. The variable is required: without an absolute path, the launcher refuses
to start. The host uses `ECOSYSTEM_DATA_ROOT` for
writable runtime data; see [host paths](../../docs/reference/operations.md#host-paths).
The library functions `checkLauncher(buddyFile, installRoot)` and
`runLauncher(buddyFile, installRoot, stop)` require explicit paths; importing
those modules starts no process and discovers no installation root.

## Task programs

The launcher knows its tasks at build time: `gherkin`, `implement`, `fix`,
`verify` and `land`. A buddy file that lists any other task is refused. For task
`TASK`, the launcher runs `TASK.mjs` in the install root, for example
`$ECOSYSTEM_INSTALL_ROOT/verify.mjs`. The same build produces the launcher and
every task program, so no registration file maps tasks to programs.

Before it reads a token, discovers starts or launches work, the launcher requires
every configured task to have its installed program. Each program must be a
regular file owned by the operator and writable by nobody else. Symbolic links
are refused. `--check` performs these checks without contacting GitHub.

## Task subprocess boundary

For each discovered start, the launcher runs the task's installed program with
`--invocation`. Standard input contains the strict version 1 issue-host
invocation from `@ecosystem/task-runtime/issue/invocation`: task id, issue,
verified account name and explicit repository-settings path, base branch and
claim-confirmation delays. It contains no buddy path or credentials.

A separate inherited pipe, descriptor 3, provisions the verified account's
credential environment and private variable names. The bootstrap validates both
channels, checks task and account bindings, closes the credential descriptor and
keeps credentials inside host capabilities. They never appear in the ordinary
invocation, command line or model-child environment. The launcher filters
inherited credential variables from the subprocess environment. This is process
and configuration isolation, not a same-user filesystem sandbox.

`--invocation` is the only form a task program accepts. Domain task code never
reads a buddy file.

The issue adapter claims each start in its task subprocess. Running labels,
`agents:stop`, final reporting, pinned-head review and merge checks, trusted
policy loading and recovery from GitHub keep their authority there. A failed
child is logged and does not stop discovery. Failed listings are warnings and do
not become empty authoritative state.

SIGTERM or SIGINT stops discovery and drains live task subprocesses. It does not
kill them. Apply `agents:stop` to cancel their work at guarded boundaries while
preserving cleanup and final reports. The launcher exits after its children and
prints its final JSON line. It writes child exits and discovery warnings to stderr.

## Install a release

1. Drain the running buddies and preserve retained checkouts and run folders.
2. Install the merged release using the [installation procedure](../../docs/reference/operations.md#install-a-release).
3. Confirm `launcher.mjs` and every task program are installed together.
4. Validate each buddy file with `launcher.mjs --config BUDDY_FILE --check`.
5. Restart one launcher per buddy.

The installer backs up replaced files and records `INSTALLED.json`. It does not
rewrite private configuration or retained work. Launchers and task programs come
from the same release. A source merge alone activates nothing.

## Validate source

Use Node 24 and `npm ci --ignore-scripts --no-audit --no-fund`. Both root gates
include this workspace. The pipeline system and acceptance suites run the built
launcher against fake GitHub and real subprocesses, covering discovery, claims,
program refusal, credential isolation, child failures and graceful shutdown.
