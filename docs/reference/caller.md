# Caller retirement

The caller-owned stage launcher is retired. `caller-jobs.mjs` and `job.mjs` are no longer distributed, and their source launchers have been removed. The former caller prompt, run-folder contract and stage-selection commands do not apply to buddy runs.

## Request work

A qualified human applies `start:implement` to the issue. The buddy's sensors qualify the application event, retain its provenance and deliver it to Implement. The task still checks current requirements, prerequisites, buddy permission, ownership and stops before an action can start.

Neither filing an issue nor running standards-upgrade `apply` accepts that signal. A machine account, assignment or PR label cannot replace the human event. A passing task result may make a downstream task ready; it is not a general grant or Land permission.

The [coordination reference](coordination.md) describes admission and effects. The [runtime reference](runtime-runs.md) defines configuration, activation, stops and observations.

## Preserve former caller runs

Do not convert a former run's `stage`, lane or PID into a new task grant. Keep its branch, saved state, signed receipts, attempt evidence, consumer records and local recovery artifacts intact. Old job records remain explicitly historical dashboard observations.

A separately authorized cutover must drain old jobs and reconcile unfinished work before activating the new runtime. It must not run both launchers, adopt old state silently, reset an uncertain Land or discard work. Source delivery does not perform this cutover; see [upgrade safely](operations.md#upgrade-safely).

## Recover held work

The new runtime supplies no automatic retry or continuation operation. Label removal, process exit and an expired lease create no permission. Unknown writes require exact read-only reconciliation. Rejected or stopped bindings do not become new merely because another caller starts.

Preserve evidence and report the missing authority instead of invoking a removed stage command. Recovery must use an explicitly supported, authorized path for the retained action.
