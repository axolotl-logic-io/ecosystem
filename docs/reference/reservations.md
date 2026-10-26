# Reservations

This page describes how the pipeline reserves capacity for the three resources an action can need: a model session, a test slot and a target write. A reservation is a recorded claim on one slot of a resource. It isn't a lane, which is a stable coordination identity. The rules come from the [domain runtime contract](../domain-runtime-contract.md#reservations).

## Resources and what reserves them

Each resource has exactly one reservation system:

| Resource | What reserves it | Scope |
|---|---|---|
| `model-session` | `reserveModelSession` in `src/runtime/reservations.ts` | Shared: every machine that works on the repository and base |
| `test-slot` | The checkout slot store in `src/lane-slots.ts` (see [lane test environments](checkouts.md#lane-test-environments)) | Local: one pipeline root and repository |
| `target-write` | The target's integration turn, `integrationTurn` in `src/execution.ts` (see [the target's integration turn](merge.md#the-targets-integration-turn)) | Shared: the repository and base |

Test slots keep their project-facing variables, `ISSUE_PIPELINE_LANE_SLOT` and `ISSUE_PIPELINE_LANE_SLOTS`, unchanged.

## Model-session slots

A model-session slot is a scope of the [coordination protocol](coordination.md#keep-concurrent-work-apart), the same authenticated records and create-only epoch refs that issue execution uses. Slot `K` of a repository `REPO` on base `BASE` has the scope `["REPO","BASE","resource","model-session",K]`.

To reserve a slot, the runtime calls `reserveModelSession(cfg, execution, cap)`:

- `cfg`: the repository's loaded config.
- `execution`: the action's invocation binding. The invocation must already hold its issue's confirmed execution.
- `cap`: the number of model-session slots the repository allows. It must equal the trusted setting `resources.modelSessions`.

The call resolves to one of three states:

- `reserved`: the invocation holds slot `K` and gets a `ReservationHandle`. Calling it again for the same invocation returns the same slot.
- `waiting`: every slot within the cap is held or requested. The call cancels any request it made, so it leaves nothing behind. Retry with the same invocation, or with a new one.
- `held`: the capacity isn't trusted or doesn't match, the records can't be read, or they contradict each other. A person must reconcile them.

## Capacity

A repository and base have one model-session pool. Its capacity is the trusted repository setting `resources: { modelSessions: N }`, where `N` is a positive integer. The setting has no default. In committed-project-policy mode it belongs to the pinned project document, and the shared policy digest covers it (see [project settings](project-settings.md)). `reserveModelSession` resolves to `held`, and writes nothing, when the setting is missing or invalid or when `cap` differs from it.

The cap isn't part of a slot's scope, so machines whose trusted settings disagree never get separate pools. Each slot request records the cap its caller passed. A claim is live while it's an owner that hasn't released or a request that hasn't been cancelled. `reserveModelSession` resolves to `held` when any live claim in the pool declares no cap or a different one. It checks twice:

- Before requesting, so a caller with another cap never joins the pool.
- After acquiring a slot. If a contender with another cap appeared meanwhile, the caller releases the slot it just took, which has no consumers yet, and holds. Of two holders with different caps, the later one to acquire always sees the other's claim.

To change the cap, drain the pool first: release every slot, then reserve under the new cap. Claims that were released or cancelled don't count.

A declared cap only records what its writer read from its trusted setting. It isn't a policy of its own: it lets machines with different settings detect each other, and the pool never grows beyond what any live claim's writer trusted.

## Records and execution

Every read and write of a slot also checks the holder's issue execution, so a holder whose execution was lost can't record anything on its slot. The slot's records are comments on the holder's issue, and the pipeline reads them from the whole repository's comments.

## Consumers and release

A consumer is something that uses the slot, such as one model launch. It's named by a `kind` and an `id`.

1. Before a consumer starts, call `register(consumer)`. The registration is written and read back before the call resolves.
2. Once the consumer has certainly ended, for example when its process exit is observed, call `done(consumer)`.
3. Call `release()`. It releases the slot only when every registered consumer has reported done.

`release()` doesn't reject. It resolves to `{ released, reason }`, and `released` is false while any consumer isn't done or the records can't be read. A second release of a released slot resolves to `released: true`.

`register` and `done` reject in these cases:

- `done` for a consumer that was never registered.
- `register` for a consumer that already reported done. Use a new `id`.
- A write whose outcome is unknown. Its journal holds the holder's issue, as for any [coordination problem](coordination.md#preserve-interrupted-work).

Registering a running consumer again, and reporting done twice, change nothing.

## What keeps a slot held

Only the holder's own release frees a slot. These events release nothing:

- The holder's process or run ends.
- The holder's issue closes.
- A consumer goes idle, or its state is unknown.
- A later invocation of the same issue starts. It can't retire an earlier invocation's slot.

These conditions hold every slot, and `reserveModelSession` resolves to `held`:

- A coordination record anywhere in the repository is malformed, unreadable, of an unknown version such as 1, or written by an account other than the landing account.
- A record in a slot's scope isn't version 3, or a version 3 record names another scope.
- The caller's cap differs from the trusted capacity setting. A missing or invalid setting stops the config from loading at all.
- A slot request doesn't declare a cap, or a live claim declares a cap other than the caller's.
- A consumer is registered twice, or reports done without a registration.
- A release record appears while a consumer isn't done.

A slot that a dead holder keeps needs a person: no expiry, lease age or restart frees it.

## Versions and limits

- **Record versions stay explicit.** Slot records are version 3. Their requests declare a `cap`, and they add `register` and `done` records, which name a `consumer`. Issue and integration records are version 2. A record in any other version, including version 1 records an earlier release wrote, holds every slot.
- **Capacity is per repository and base.** Two repositories, or two bases of one repository, have separate pools.
- **A crash between requesting and cancelling leaves a request.** The request counts against the cap and is first in its slot's queue. Only that invocation can acquire or cancel it, so the slot stays held until a person reconciles it.

### Scenario trace

Each row names the scenario and the test that proves it through real processes and a shared fake `gh`.

| Scenario | Proved by |
|---|---|
| Concurrent invocations in separate processes fill the cap once, and a waiting one leaves no request | `test/model-session-reservations.test.ts` |
| A reservation outlives its process; release waits for every registered consumer's done report | `test/model-session-reservations.test.ts` |
| A lost done report, a malformed record and an untrusted record each keep the slot held | `test/model-session-reservations.test.ts` |
| A record of another version holds; a slot record without version 3 grants nothing | `test/model-session-reservations.test.ts` |
| A caller cap that differs from the trusted capacity holds and writes nothing | `test/model-session-reservations.test.ts` |
| Concurrent machines whose trusted capacities differ never hold slots under both caps | `test/model-session-reservations.test.ts` |
| After the trusted capacity changes, callers hold until the pool drains | `test/model-session-reservations.test.ts` |
| A slot request without a declared cap grants nothing | `test/model-session-reservations.test.ts` |
