# Orchestrator

`@ecosystem/orchestrator` supervises one standalone launcher process per buddy.
It owns fleet validation and process lifecycle. Launchers own discovery and task
selection; task subprocesses retain claims, cancellation guards and recovery.

The version 1 operator-owned JSON configuration names absolute paths:

```json
{
  "version": 1,
  "buddies": ["/private/buddies/first.json", "/private/buddies/second.json"],
  "launcher": "/installed/ecosystem/launcher.mjs"
}
```

Point `launcher` at `launcher.mjs` in the install root. The orchestrator resolves
the install root as the launcher does, from `ECOSYSTEM_INSTALL_ROOT` or its
compatibility fallbacks. It validates every buddy's task programs there and
passes the same root to each launcher as `ECOSYSTEM_INSTALL_ROOT`.

Fleet files written before [#280](https://github.com/axolotl-logic-io/ecosystem/issues/280)
also named a `manifest` path. The fleet file stays version 1, because its
remaining fields keep their meaning. The orchestrator refuses a file that still
has `manifest`, rather than ignoring it, so that a stale path can't appear to
select programs. To migrate, delete the `manifest` line and validate the file.

All entries are validated before startup. Duplicate buddy files, names or GitHub
accounts are refused, including accounts in different configuration folders.
Automatic restarts are disabled: each buddy starts at most once per orchestrator
invocation. Failed launchers are reported while healthy launchers keep running.

## Validate and start a fleet

After installing the release, validate the complete configuration:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/orchestrator.mjs" --config FLEET_FILE --check
```

`FLEET_FILE` is the absolute path of the private fleet JSON file. Omit `--check`
to start one launcher per entry. Keep the file, launcher, buddy files,
repository files and task programs owned by the operator and writable by nobody
else. Symbolic links to these trusted files are refused. Unknown configuration
fields, including `manifest`, unsupported versions, empty fleets and missing or
untrusted task programs refuse startup before any child starts. `--check` does
not read tokens or contact GitHub; each launcher verifies its credential before
discovery. All configured buddy credential variable names are removed from every
launcher environment, alongside the shared credential filters. Tokens remain in
private credential files and the task bootstrap credential pipe.

The orchestrator invokes the configured public launcher program with Node 24,
`--config BUDDY_FILE`. It does not import task code or
perform issue discovery. A launcher revalidates its own inputs at startup. Do not
edit configuration or replace installed programs while starting a fleet.

## Child failures and restart policy

Each buddy has one process attempt and zero automatic retries. A process creation
failure drains every child already created, waits for their exits and exits 1.
After process creation, any unexpected launcher exit, including exit 0, marks that
buddy failed. Healthy siblings continue discovering work. The orchestrator exits
1 after all launchers have ended if any buddy failed; otherwise it exits 0.

Reports on stderr are JSON lines with a timestamp, buddy name and `kind`:
`started` includes the process id; `output` wraps a launcher's stdout or stderr
line with its stream name; `error` reports process errors; `exited` includes code
and signal; `draining` records a shutdown request. Stdout holds the final
`{"kind":"stopped","failed":[]}` result, with failed buddy names when present.
No fleet ledger, shared database or pipeline stage state is written.

To recover a failed buddy, inspect its launcher report, fix its configuration or
runtime problem and start that buddy through the standalone launcher. Keep it
outside the fleet until the next coordinated fleet restart. Never start another
copy of a healthy buddy. Existing issue claims and retained work remain the
recovery authority; the orchestrator does not release claims or replay tasks.

## Shutdown and activation

SIGTERM or SIGINT sends SIGTERM to every live launcher once. Each launcher stops
discovery and drains its live task subprocesses. The orchestrator waits for all
launcher exits. It does not signal task children, impose a drain deadline or
escalate to SIGKILL. Repeated signals do not bypass the drain. To cancel in-flight
work at guarded boundaries, apply `agents:stop` to its issues, then let cleanup
and final reports complete. A terminal interrupt can also reach task processes in
the terminal process group. A stuck task needs operator investigation; force
termination can leave a recoverable claim and retained checkout.

To adopt supervision, drain the existing standalone launchers, preserve retained
work, install the release, write and validate the fleet file, then start the
orchestrator. Do not run the old launchers alongside their supervised replacements.
The installer includes `orchestrator.mjs` without writing private fleet files.
See [installation and safe upgrades](../../docs/reference/operations.md#install-a-release).
Standalone launchers remain supported.

## Validate source

Use Node 24 and `npm ci --ignore-scripts --no-audit --no-fund`. Run root
`npm run check` and `npm run check:full` before landing. Component integration
tests use real subprocesses and event handshakes for failure and drain behavior.
Pipeline system tests run the installed orchestrator and standalone launchers
against fake GitHub, including in-flight task cancellation through issue guards.
