# Launcher

`@ecosystem/launcher` runs one configured buddy. It owns the version 2 buddy
file, repository scope, account verification, duplicate-account protection and
start-label discovery. It runs standalone or under the [orchestrator](../orchestrator/README.md), which supervises one launcher process per buddy. Task definitions live in
root `tasks/` workspaces and receive explicit validated inputs and task-specific
capabilities from their bootstrap.

## Run a buddy

After installing the release, validate a buddy and its task registrations:

```sh
node "$ISSUE_PIPELINE_ROOT/launcher.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is an absolute path to an operator-owned version 2 buddy file.
Omit `--check` to run it. The installed `buddy.mjs` is a compatibility entrypoint
for the same launcher, with the same arguments and exit behavior. Existing buddy
files need no edits. See the [buddy file reference](../../docs/reference/runtime-runs.md#launcher-buddy-file).

`--manifest MANIFEST_FILE` selects an explicit installed task manifest. The
default is `$ISSUE_PIPELINE_ROOT/tasks.json`, with the existing installation-root
default when that variable is absent. The library functions
`checkLauncher(buddyFile, manifestFile)` and
`runLauncher(buddyFile, manifestFile, stop)` require explicit paths; importing
those modules starts no process and discovers no installation root.

## Task registrations

The build and installer supply `tasks.json`. It is strict, versioned JSON:

```json
{
  "version": 1,
  "tasks": [
    { "id": "gherkin", "executable": "gherkin.mjs" },
    { "id": "implement", "executable": "implement.mjs" },
    { "id": "fix", "executable": "fix.mjs" },
    { "id": "verify", "executable": "verify.mjs" },
    { "id": "land", "executable": "land.mjs" }
  ]
}
```

Executable names can differ from task ids. Relative paths resolve beside the
manifest; absolute paths are supported. The launcher validates the entire
manifest, refuses duplicate ids and requires every configured task to be
registered before verifying credentials, discovering starts or launching work.
The manifest and executable files must be regular files owned by the operator
and writable by nobody else. Unknown fields, unsupported versions and missing
programs refuse startup. `--check` performs these checks without contacting GitHub.

## Task subprocess boundary

For each discovered start, the launcher runs the registered program with
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

The compatibility task CLI `TASK.mjs --config BUDDY_FILE --issue OWNER/REPO#N`
remains supported. Its host calls the launcher's identity resolver, including
task authorization and repository-scope checks. Domain task code never reads a
buddy file. Launcher-created children use only the new invocation form.

The issue adapter still claims each start in its task subprocess. Running labels,
`agents:stop`, final reporting, pinned-head review and merge checks, trusted
policy loading and recovery from GitHub retain their existing authority. A failed
child is logged and does not stop discovery. Failed listings are warnings and do
not become empty authoritative state.

SIGTERM or SIGINT stops discovery and drains live task subprocesses. It does not
kill them. Apply `agents:stop` to cancel their work at guarded boundaries while
preserving cleanup and final reports. The launcher exits after its children and
prints its final JSON line. It writes child exits and discovery warnings to stderr.

## Migrate an installation

1. Drain the running buddies and preserve retained checkouts and run folders.
2. Install the merged release using the [pipeline installation procedure](../issue-pipeline/README.md#install-and-safe-upgrades).
3. Confirm `launcher.mjs`, `buddy.mjs`, `tasks.json` and every registered executable are installed together.
4. Validate each existing buddy file with `launcher.mjs --config BUDDY_FILE --check`.
5. Restart one launcher per buddy with the existing private configuration.

The installer backs up replaced files and records `INSTALLED.json`. It does not
rewrite private configuration or retained work. Do not mix old launchers with
new task bootstraps during cutover. A source merge alone activates nothing.

## Validate source

Use Node 24 and `npm ci --ignore-scripts --no-audit --no-fund`. Both root gates
include this workspace. The pipeline system and acceptance suites run the built
launcher against fake GitHub and real subprocesses, covering discovery, claims,
registration refusal, credential isolation, child failures and graceful shutdown.
