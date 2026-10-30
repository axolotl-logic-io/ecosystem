# Check gates

Use Node 24 and `npm ci --ignore-scripts --no-audit --no-fund`. Source validation
never installs a release or starts live buddies.

## Fast default

From the repository root:

```sh
npm run check
```

The distribution gate typechecks and lints root build/install code and tests,
builds every manifest program and asset into root `dist/`, and checks installer
and built-program syntax. Every workspace then runs its own `check` script.
The issue host typechecks and lints source, adapters and test kits. Task,
framework, shared runtime, launcher, orchestrator and dashboard workspaces also
run their own component or component integration tests. The database workspace
checks types and lint without connecting to PostgreSQL.

This is the **fast default** gate. It does not run the host's claim, recovery,
model, policy, standalone-tool and public-entrypoint system suite, or the root
clean-distribution acceptance suite. Typechecking those tests does not run them.

## Full gate

Before landing the modular distribution cutover, explicitly run:

```sh
npm run check:full
```

This runs the fast gate, then `npm run test:runtime` from the repository root:

```sh
node --test --test-concurrency=8 --test-timeout=180000 \
  'apps/issue-host/test/{component,component-integration,system,acceptance}/**/*.test.ts' \
  'test/{component,component-integration,system,acceptance}/**/*.test.ts'
```

The suite covers task claims and overlaps, launcher/fleet shutdown, all five
installed tasks, credential-free model sessions, policy trust, pinned-head
review/merge, recovery, standalone tools, installer ownership and separate host
data. Flow test machines use the real installer, local Git and fake GitHub/models.
New files in these levels are discovered automatically. Concurrency stays at 8
and the per-test timeout at 180000 ms. Fix slow or flaky behavior; do not increase
the deadline or rerun a failure until it happens to pass.

External `system-integration` tests remain opt-in and excluded from both gates.
Database integration tests also remain separate: see
[database testing](database.md#test-the-database-contract).

## Continuous integration

`.github/workflows/check.yml` runs on PRs and pushes to `main`:

- `check` runs the root fast gate. Branch protection requires it and requires the branch to be current with `main`.
- Eight test shards build the root distribution and run both host and root test trees. The aggregate `tests` check requires every shard to pass.
- `database` runs the shared database checks and real-database suites against disposable PostgreSQL.

The `tests` and `database` results are additional evidence even when branch
protection requires only `check`. All selected gates must pass before landing;
a passing required check does not erase a failed test. A newer PR push cancels
its older workflow run.

## Evidence

Record each result's source SHA and dirty state, exact command and working
directory, selected test levels, concurrency and timeout, exit status, wall time
and retained output path. Label fast, targeted and full results accurately. Keep
the command's actual exit status before filtering output.

The full gate is required before landing this refactor. Do not rerun it after
landing or as an installation step. Verify the merged revision's existing
source-check evidence before installing. Installation and restart follow
[operations](operations.md); no source gate rewrites operator configuration,
wrappers, credentials or trusted project-policy pins.
