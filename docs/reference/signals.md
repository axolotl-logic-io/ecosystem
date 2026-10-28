# Signals

A signal is qualified evidence that a buddy may act on a work item. The signal component in `apps/issue-pipeline/src/signals/` reads control labels on issues, accepts qualified label events as records, and delivers signals of four kinds: a start, a human PR review, a stop and a machine result. This page describes how it behaves. The rules come from the [domain runtime contract](../domain-runtime-contract.md#signals).

**Note:** The installed pipeline accepts only `start:implement` and `agents:stop` until this source is installed.

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

The component reads six issue labels as control labels:

- `start:author` requests Author for the issue's current requirements.
- `start:implement` requests Implement for the issue's current requirements.
- `start:verify` requests Verify for the current head of the issue's linked PR.
- `start:fix` requests Fix for the current head of the issue's linked PR.
- `start:land` requests Land for the current head of the issue's linked PR.
- `agents:stop` stops all work on the issue.

A start label is the only thing that requests a task. No task result or PR review requests one. A label on a pull request grants nothing. Safe Refactor has no pipeline action and no label.

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
{"version":2,"kind":"accepted","id":"github-label:o/r#7:9001",...}
-->
```

The record holds these fields:

| Field | Meaning |
|---|---|
| `version` | `2`. A record of an earlier version holds its issue as invalid or of an unknown version. |
| `id` | `github-label:REPO#NUMBER:EVENT_ID` for a label event, or `github-review:REPO#NUMBER:REVIEW_ID` for a PR review. One event or review can never gain a second record or binding. |
| `workItem` | The repository and issue number. |
| `source` | For a label, the label and its event's id, node id and time. For a review, the PR and the review's id and submission time. |
| `producer` | `{ route: "human", login, userId, organization }` at acceptance. |
| `request` | What the source asks for, as the table below shows. |
| `acceptedBy` | The buddy run that appended the record. |

| Source | Request |
|---|---|
| `start:author` or `start:implement` | `start` with the task, the requirements digest and the target, read at acceptance |
| `start:verify`, `start:fix` or `start:land` | `start` with the task, the linked PR, its `head` commit and the target, read at acceptance |
| A PR review | `review` with GitHub's review id, the PR, the `commit` it was submitted against and its `state` |
| `agents:stop` | `stop` |

The component finds records by reading every page of the repository's issue comments, not by label. Removing a label doesn't hide an accepted start or stop.

The component trusts a record only when the landing account wrote it and nobody has edited it, as `comment-authority.ts` verifies. A record by anyone else, an edited record, a malformed record, or a record naming another issue holds the issue. Identical records of one event merge into the earliest. Records of one event that disagree on anything but `acceptedBy` hold the issue.

### Uncertain appends

The component appends through the coordination journal's `confirmedWrite` and then reads the record back. If the post fails but the record is there, the write is confirmed. If the component can't confirm it, the journal keeps `coordination-uncertain.json` in the issue's run directory and the issue holds. The component never posts the record again. To clear the hold, an operator reconciles the journal entry.

## Starts

A poll delivers an accepted start only when all of these hold:

- No accepted stop exists on the issue.
- No attempt of the start's task names the start's id as its cause. Any such attempt spends the start, whatever its verdict and even if the target moved.
- For Author and Implement, no attempt of that task exists for the same requirements, and `previousAction` reports no action for the exact binding. Otherwise the start is inert.
- The producer still qualifies, by retained user id.

A new Author or Implement start event for requirements that task already attempted isn't accepted. It holds with "retrying requirements Implement already attempted is unsupported", naming the task. Implement doesn't wait for Author.

The one exception is an interrupted Implement run that can continue, as [interrupted Implement runs](task-results.md#interrupted-implement-runs) describes. A new `start:implement` for its requirements is accepted and continues it.

A `start:verify`, `start:fix` or `start:land` binds the head of the issue's linked PR when the start is accepted. The linked PR comes from the issue's branch. With no linked PR, or a PR that isn't open, the start holds and nothing is recorded. A later push doesn't rewrite the accepted head; the task decides whether that head is still current, and waits for a new start when it isn't. These starts have no retry gate in the component, because their tasks bind a revision that the component can't compute.

## Reviews

For every polled issue that isn't stopped, the component reads the issue's linked PR and its reviews. It accepts a review only while it stands: it is the reviewer's latest `APPROVED` or `CHANGES_REQUESTED` review on its commit, not dismissed and not followed by a later one from the same reviewer. A superseded review is never recorded.

The reviewer must qualify the same way a label's producer does. A machine account, a non-member or a pending invitee grants nothing and adds no hold, because anyone can review a PR and a hold would block the issue indefinitely. An unknown qualification or an unreadable review listing holds the issue and makes the poll incomplete. Neither pipeline account's review is a signal: the landing account's reviews are Verify's results, and the development account authored the PR.

A poll delivers an accepted review only while it still stands, checked against a fresh listing, and while its reviewer still qualifies. A stop revokes reviews as it revokes starts, and the component doesn't deliver them while the issue's execution is owned.

A review grants nothing on its own and requests no task. A `CHANGES_REQUESTED` review on the current head is something a started Fix answers, and an `APPROVED` one counts toward Land, as the [stops and labels reference](stops-and-labels.md#human-reviews) describes. Whether a review binds the current head is the task's decision, not the component's.

Reviews are found only on issues that the component already polls: issues with a control label or an accepted record. Every issue the pipeline delivers gets a record when its start is accepted.

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

- A start or review on a stopped issue is revoked.
- A review that no longer stands, because it was dismissed or followed by the same reviewer's later review, is revoked.
- The record's retained producer must still be an active member, checked by user id. A login that now belongs to someone else doesn't qualify.
- The label doesn't need to remain.

A missing record or a mismatch is unknown, not revoked. Spending isn't rechecked here; the task lane's `beginAction` records the attempt that spends a start.

For a machine result, `requalify` checks that the task lane's `machineSignals` still returns the same result. The synchronous result check belongs to the task lane's checked ledger.

## Tests

The tests in `apps/issue-pipeline/test/component-integration/signals/` run the inbox in a driver subprocess. A fake `gh` on `PATH` forwards each call to a fake GitHub server that holds a world file, and the real journal writes to a temporary pipeline root. A test-only resolve hook, `fake-tasks-hook.ts`, replaces `src/tasks/index.ts` with canned task answers. These tests prove the component's transport and rules, not integration with the real task lane.
