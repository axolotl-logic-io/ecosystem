# Signals

A signal is qualified evidence that a buddy may act on a work item. The signal component in `apps/issue-pipeline/src/signals/` reads control labels on issues, accepts qualified label events as records, and delivers three kinds of signal: a start, a stop and a machine result. This page describes how it behaves. The rules come from the [domain runtime contract](../domain-runtime-contract.md#signals) and the decisions in [authority](../decisions/authority.md) and [buddies and tasks](../decisions/buddies-and-tasks.md).

**Note:** The component isn't integrated yet. It imports `src/domain.ts` and `src/tasks/index.ts` from the tasks lane, and nothing calls it until the buddy runtime does.

## Public API

`src/signals/inbox.ts` is the only module that other code imports from `src/signals/`.

| Export | Use |
|---|---|
| `SignalScope` | `{ organization }`: the organization whose members' label events qualify. The buddy configuration names it. The component never derives it from the repository owner. |
| `pollSignals(cfg, scope, buddyRun)` | Reads every source afresh, accepts new qualified label events, and returns a `SignalInbox` of signals, holds and `complete`. |
| `requalify(cfg, scope, signal)` | Checks one delivered signal again just before an action relies on it. Returns `qualified`, `revoked` or `unknown` with a reason. |
| `stopLatch(cfg, number)` | Reports whether an issue is stopped: `latched`, `clear` or `unknown`. |
| `requalifyHumanNow(cfg, scope, source)` | The synchronous form of `requalify` for an accepted human signal named by `{ id, recordId, workItem }`. Ops mutation guards call it. |
| `stopLatchNow(cfg, number)` | The synchronous form of `stopLatch`, for ops mutation guards. |

The synchronous forms run the same code as the asynchronous ones. There is one signal policy, not two.

## Control labels

Two issue labels are control labels:

- `start:implement` requests Implement for the issue's current requirements.
- `agents:stop` stops all work on the issue.

A label on a pull request grants nothing. A start label doesn't request Author or Safe Refactor.

To accept a label for the first time, the component needs both of these:

- The open issue carries the label now.
- The latest `labeled` or `unlabeled` event for that label is a `labeled` event. If the latest event is `unlabeled` while the label is present, the evidence contradicts itself and the issue holds.

## Who may apply a control label

A label event qualifies only when a person applied it directly and that person is an active member of `scope.organization`. These label events grant nothing:

- an event performed through a GitHub App, even on a member's behalf;
- an event by an account whose type isn't `User`, or whose login ends in `[bot]`;
- an event by a configured pipeline account: `devAccount` or `landingAccount`.

The component checks membership through the landing account's credential, in two reads:

1. `GET user/memberships/orgs/ORG` checks that the reader itself is an active `admin` or `member` of the organization. Otherwise the reader can't tell members from non-members, and every label holds.
2. `GET orgs/ORG/memberships/LOGIN` checks the event's actor. The answer must name the actor's user id and the organization, through `organization_url` or the optional `organization` object.

`ORG` is `scope.organization`, and `LOGIN` is the event actor's login.

| Membership answer | Result |
|---|---|
| Active member or admin, same user id | Qualified |
| `404` | Rejected: not a member |
| Pending invitation | Rejected |
| Another user id than the event's | Unknown: holds |
| Unreadable, malformed or another organization | Unknown: holds |

Organization membership doesn't replace the trusted-requirements rules. The allow-list and current collaborator rule still apply where they did before.

## Reading GitHub

Every GitHub read is one `gh api --include --method GET` call. The component makes no automatic retries. For each listing, it reads every page by following the `Link` header, requesting `per_page=100`.

A listing that the component can't trust holds; it is never read as empty or shorter. The listing holds in these cases:

- a page fails;
- a page has more rows than requested, or repeats a row id;
- a `Link` header is malformed, points to another host, changes the query apart from `page`, or skips a page.

When any read is unknown, `complete` is `false`. A failure never reads as "no labels", "no records" or "not a member".

## Accepted records

To accept a label event, the landing account appends a hidden issue comment. It never edits the comment afterwards.

```
<!-- agent-pipeline:signal
{"version":1,"kind":"accepted","id":"github-label:o/r#7:9001",...}
-->
```

The record holds these fields:

| Field | Meaning |
|---|---|
| `id` | `github-label:REPO#NUMBER:EVENT_ID`, where `EVENT_ID` is the label event's id. One event can never gain a second record or binding. |
| `workItem` | The repository and issue number. |
| `source` | The label and its event's id, node id and time. |
| `producer` | `{ route: "human", login, userId, organization }` at acceptance. |
| `request` | `start` with `task: "implement"`, the requirements digest and the target, or `stop`. |
| `acceptedBy` | The buddy run that appended the record. |

The component finds records by reading every page of the repository's issue comments, not by label. Removing a label doesn't hide an accepted start or stop.

The component trusts a record only when the landing account wrote it and nobody has edited it, as `comment-authority.ts` verifies. A record by anyone else, an edited record, a malformed record, or a record naming another issue holds the issue. Identical records of one event merge into the earliest. Records of one event that disagree on anything but `acceptedBy` hold the issue.

### Uncertain appends

The component appends through the coordination journal's `confirmedWrite` and then reads the record back. If the post fails but the record is there, the write is confirmed. If the component can't confirm it, the journal keeps `coordination-uncertain.json` in the issue's run directory and the issue holds. The component never posts the record again. To clear the hold, an operator reconciles the journal entry.

## Starts

A poll delivers an accepted start only when all of these hold:

- No accepted stop exists on the issue.
- No Implement attempt names the start's id as its cause. Any such attempt spends the start, whatever its verdict and even if the target moved.
- No Implement attempt exists for the same requirements. Otherwise the start is inert.
- `previousAction` reports no action for the exact binding.
- The producer still qualifies, by retained user id.

A new start event for requirements that Implement already attempted isn't accepted. It holds with "retrying requirements Implement already attempted is unsupported". No label or operation continues or retries work.

## Stops

Any accepted stop latches its issue across buddy runs. Removing `agents:stop` never clears the latch, and a later start label on that issue holds. A stop also makes every pending start on the issue inert, and `requalify` revokes a start on a stopped issue.

`stopLatch` reports:

| State | When |
|---|---|
| `latched` | An authentic accepted stop exists. |
| `clear` | No accepted stop, and either no `agents:stop` label or a label that a machine applied. |
| `unknown` | Any read failed, a record or journal problem holds the issue, the label's events contradict it, or a person's stop label isn't accepted yet. |

An unknown latch is never clear.

## Requalification

`requalify` and `requalifyHumanNow` reread the issue's authenticated records. They don't trust the caller's copy of the signal. The record named by `recordId` must accept exactly the given id, and for `requalify`, exactly the given signal. Then:

- A start on a stopped issue is revoked.
- The record's retained producer must still be an active member, checked by user id. A login that now belongs to someone else doesn't qualify.
- The label doesn't need to remain.

A missing record or a mismatch is unknown, not revoked. Spending isn't rechecked here; the task lane's `beginAction` records the attempt that spends a start.

For a machine result, `requalify` checks that the task lane's `machineSignals` still returns the same result. The synchronous result check belongs to the task lane's checked ledger.

## Tests

The tests in `apps/issue-pipeline/test/signals/` run the inbox in a driver subprocess. A fake `gh` on `PATH` answers from a world file, and the real journal writes to a temporary pipeline root. A test-only resolve hook, `fake-tasks-hook.ts`, replaces `src/tasks/index.ts` with canned task answers. These tests prove the component's transport and rules, not integration with the real task lane.
