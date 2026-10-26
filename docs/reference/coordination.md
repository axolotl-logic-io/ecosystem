# Coordination

A buddy run activates its configured task loops. Each task owns its sensors, matching, prerequisites, action and recovery. The runtime delivers qualified signals and admits one action at a time within a buddy; it does not select a saved stage or manage a generic task graph.

## Configure a buddy

Keep repository policy, operator credentials and buddy configuration separate. The [runtime reference](runtime-runs.md#buddy-configuration) defines the strict buddy file, organization scope, role, responsibilities, identity and access profiles. Repository `resources.modelSessions` supplies the shared capacity; there is no buddy-level capacity override.

Issue delivery has five tasks ([delivery-tasks](../decisions/pr-review.md#delivery-tasks)). A Developer buddy's default responsibilities are Author, Implement and Fix, with the writer profile. A Gatekeeper's are Verify, with the reader profile, and Land, with the lander profile. Safe Refactor retains its [standalone entrypoint](safe-refactor.md). Merely configuring a responsibility supplies no causal signal or execution permission.

**Note:** The installed pipeline still runs the older Harden, Sync, Integrate, Review Security and Complete tasks. The five-task source runs only once it is landed and installed.

To validate configuration without activating a run:

```bash
node "$ISSUE_PIPELINE_ROOT/buddy.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is an absolute path to the private operator-owned buddy JSON file. To activate the accepted configuration, omit `--check`. Activation and any required installation remain separate operator actions.

## Admit an action

The runtime independently checks the current buddy grant, qualified cause, work-item stop state, fenced issue execution and any required shared resource reservation. An unavailable resource waits; unknown or conflicting authority holds. Local run files cannot grant permission.

Qualified human events on the issue and its pull request (PR) provide human signals:

- `start:author` requests Author for the issue's current requirements.
- `start:implement` requests Implement for its requirements binding.
- `start:verify` requests Verify for the current head of the issue's linked PR.
- `agents:stop` requests a cooperative work-item stop.
- A submitted `CHANGES_REQUESTED` or `APPROVED` review on the linked PR binds the head it names.

The current signal component accepts only `start:implement` and `agents:stop`; the others are the decided design. The event must name a qualified human producer in the configured organization. Complete event reads, membership checks and authenticated acceptance records remain necessary. A bot, App, PR label, present label alone or assignment supplies no human authority. Removing a label creates no continuation signal. See [stops and labels](stops-and-labels.md).

A start is spent by its authenticated action attempt, even if the attempt fails or the target later moves. The same unchanged requirements don't receive an automatic Implement retry. Implement doesn't wait for an unsettled Author.

Results drive the rest of the loop. A new PR head wakes Verify. A refused Verify, a person's request-changes review or Land's conflict wakes Fix. An approved head wakes Land. These results don't grant Land permission; Land still checks its own prerequisites.

## Keep concurrent work apart

Each admitted action has a fresh UUID, used by its execution invocation and task attempt. Each buddy activation and model session has a separate UUID. Explicit parent and previous links connect them; names and timestamps do not.

Issue execution uses authenticated requests and create-only epoch refs. Every substantive mutation freshly checks ownership as well as its task, buddy, cause, stop and saved write authority. A lost response retains its journal until exact read-back settles it. An expired lease, ended process or closed issue releases nothing.

Model-session reservations share one repository/base/resource pool at the trusted cap. Live cap disagreement holds the pool. A holder releases only after every registered consumer has durably finished; a retained checkout or pending setup can retain a resource. Changing capacity requires a drained pool.

Land separately acquires the target's integration turn before recording its attempt. An unavailable turn waits without spending an attempt. An uncertain Land retains the turn for read-only reconciliation. The runtime does not create a second target-write pool.

## Read observations

The [run-file reference](runtime-runs.md#observation-files) defines buddy and action records. The [dashboard](../../apps/workflow-dash/README.md) shows their explicit links, uncertain outcomes, retained ownership, held reservations and incomplete coverage.

These are observations, not receipts or authorization. Generic subagent records are not buddy runs.

## Preserve interrupted work

A stop prevents new substantive work in its scope. A credentialed write, rebase or Land already in flight is not killed or replayed. Checkpointing, evidence-only settlement and lossless checkout preservation follow their own fresh authorization and ownership guards.

A failed or uncertain checkpoint keeps the work and required ownership/resources. Retain binary-safe staged and working patches, verified Git bundles, stopped-rebase state, journals and consumer records. Do not reset a checkout, clear evidence or release resources merely to permit another action.

Read-only recovery settles the original action; it does not begin a replacement attempt. A review loop at its limit or an uncertain effect remains a hold. There is no label-removal restart, automatic retry or undefined continuation command.
