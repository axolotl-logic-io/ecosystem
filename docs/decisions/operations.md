# Operations decisions

These decisions cover how the pipeline is run: who assigns work, the model runtime, rate limits and checkouts. [Coordination](../reference/coordination.md), [runtime](../reference/runtime.md), [checkouts](../reference/checkouts.md) and [operations](../reference/operations.md) reference describe the current behavior.

## caller-assigns-the-work

The caller chooses each job's issue, stage and branch, and runs merges one at a time. A job runs one stage of one issue and never picks other work.

## pipeline-owned-native-runtime

Every session uses Pi's native sessions and context compaction under settings the pipeline controls. Personal and project settings are ignored. An unsupported or unverified setup refuses to start.

## declared-runtime-toolchain

A session's toolchain comes from one declared, non-secret environment (`runtime.toolchainEnv`): absolute `PATH` entries and mise's data, state, cache and configuration locations. The version probe, Pi and the session's tools all use it, so a HOME-relative shim resolves the same under the dedicated runtime HOME as under the operator's. The dedicated HOME stays configuration isolation; no credential or personal Pi setting is inherited that wasn't before.

## rate-limit-defers

Provider and GitHub read rate limits defer the issue for the caller to retry later, without using up a fix attempt. An uncertain merge never gets a blind retry; it stops for read-only reconciliation.

## worktrees-and-branches

Each job works in its own checkout. Before discarding local work, save it as recovery evidence. Never delete retained work to get a fresh start. Recovery evidence is data, not authority.
