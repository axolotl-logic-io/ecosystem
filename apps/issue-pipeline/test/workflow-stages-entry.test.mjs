// The sweep's entry and exit (src/workflow/stages/entry.ts), driven directly
// with recorded ops replies: the sweep op, each claim's meaning for the sweep,
// the closing launches and the summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSummary,
  claimLaunch,
  claimStep,
  finishLaunches,
  sweepLaunch,
  sweepReplyOf,
} from "../src/workflow/stages/entry.ts";
import { claimAt, sweepReply } from "./workflow-stages-fixtures.mjs";

const ISSUE = 7;
const PARENT = 5;
const SWEEP_FAILED = /^Error: sweep failed: gh is down$/u;
const MALFORMED = /^Error: sweep failed: the sweep reply was malformed$/u;
const ALLOCATED = 5;
const BRANCH_MOVED = "the PR branch changed outside the pipeline";

// The state of a won claim at review, its head last seen at `headSha`.
function stateAt(headSha) {
  return claimAt("review", { pr: 42, headSha }).state;
}

test("the sweep op asks for every candidate, or for one issue", () => {
  assert.deepEqual(sweepLaunch(null), {
    kind: "op",
    name: "sweep",
    op: "sweep",
    payload: {},
    minutes: 20,
  });
  assert.deepEqual(sweepLaunch(ISSUE).payload, { only: ISSUE });
});

test("a failed sweep reply fails the sweep with its error", () => {
  assert.throws(
    () => sweepReplyOf({ ok: false, error: "gh is down" }),
    SWEEP_FAILED,
  );
  assert.throws(() => sweepReplyOf({ ok: true, items: [] }), MALFORMED);
});

test("a sweep reply gives its config, candidates and parents as they are", () => {
  const reply = sweepReply({ items: [ISSUE], parents: [PARENT] });
  const read = sweepReplyOf(reply);
  assert.equal(read.config, reply.config);
  assert.deepEqual(read.items, [{ number: ISSUE, depth: 0 }]);
  assert.deepEqual(read.parents, [PARENT]);
  assert.equal(read.waiting, 0);
});

test("a claim is keyed by its issue and has 15 minutes", () => {
  assert.deepEqual(claimLaunch(ISSUE), {
    kind: "op",
    name: "i7-claim",
    op: "claim",
    payload: { number: ISSUE },
    minutes: 15,
  });
});

test("a lost claim gives the abandoned entry, so the next candidate is claimed", () => {
  const lost = { ok: true, lost: true, holder: "lane-b", posted: true };
  assert.deepEqual(claimStep(ISSUE, lost), {
    kind: "lost",
    abandoned: { issue: ISSUE, holder: "lane-b", commented: true },
  });
  assert.deepEqual(claimStep(ISSUE, { ok: true, lost: true }), {
    kind: "lost",
    abandoned: { issue: ISSUE, holder: null, commented: false },
  });
});

test("a failed claim, or one with no state, is a failed claim with its reason", () => {
  assert.deepEqual(claimStep(ISSUE, { ok: false, error: "locked" }), {
    kind: "failed",
    reason: "locked",
  });
  assert.deepEqual(claimStep(ISSUE, { ok: true }), {
    kind: "failed",
    reason: "the claim reply had no valid state and paths for the issue",
  });
  const { state } = claimAt("review");
  assert.equal(claimStep(ISSUE, { ok: true, state }).kind, "failed");
});

test("a head that moved stops the claimed issue with both heads", () => {
  const won = { ...claimAt("review"), state: stateAt("aaaaaaa") };
  const step = claimStep(ISSUE, { ...won, remoteHead: "bbbbbbb" });
  assert.equal(step.kind, "claimed");
  assert.equal(step.st, won.state);
  assert.deepEqual(step.stop, {
    reason: BRANCH_MOVED,
    detail: "Expected aaaaaaa, found bbbbbbb.",
    code: null,
  });
});

test("an equal or missing head gives no stop", () => {
  const won = { ...claimAt("review"), state: stateAt("aaaaaaa") };
  assert.equal(claimStep(ISSUE, { ...won, remoteHead: "aaaaaaa" }).stop, null);
  assert.equal(claimStep(ISSUE, { ...won, remoteHead: null }).stop, null);
  const fresh = claimAt("triage");
  assert.equal(
    claimStep(ISSUE, { ...fresh, remoteHead: "bbbbbbb" }).stop,
    null,
  );
});

test("an open issue closes its parents, then is released with its state", () => {
  const { state } = claimAt("review");
  const launches = finishLaunches([PARENT], {
    n: ISSUE,
    openState: state,
    queued: 1,
  });
  assert.deepEqual(launches, [
    {
      kind: "op",
      name: "p5-close",
      op: "close-parent",
      payload: { number: 5 },
    },
    {
      kind: "op",
      name: "i7-release",
      op: "release",
      payload: { number: ISSUE, state },
    },
  ]);
});

test("a closed issue posts its queued comments, or launches nothing", () => {
  const queued = { n: ISSUE, openState: null, queued: 2 };
  assert.deepEqual(finishLaunches([], queued), [
    { kind: "op", name: "i7-post", op: "post", payload: { number: ISSUE } },
  ]);
  assert.deepEqual(finishLaunches([], { ...queued, queued: 0 }), []);
  assert.deepEqual(finishLaunches([], null), []);
});

// The summary of a sweep of `item`.
function summaryOf(item) {
  return buildSummary({
    sweepId: "s1",
    lane: "lane-a",
    reply: sweepReplyOf(sweepReply()),
    abandoned: [],
    item,
    parentsClosed: 0,
    cleanup: { worktrees: [], error: null },
  });
}

test("the summary of a sweep with no issue lists no items", () => {
  assert.deepEqual(summaryOf(null), {
    sweep: "s1",
    lane: "lane-a",
    repo: "o/r",
    waiting: 0,
    abandoned: [],
    items: [],
    parentsClosed: 0,
    cleanup: { worktrees: [], error: null },
  });
});

test("the summary of a failed claim has no state", () => {
  const item = { n: ISSUE, st: null, outcome: "claim-failed", reason: "x" };
  assert.deepEqual(summaryOf(item).items, [
    {
      issue: ISSUE,
      pr: null,
      stage: null,
      outcome: "claim-failed",
      reason: "x",
      allocatedTokens: null,
      rebaseAllocatedTokens: null,
    },
  ]);
});

test("the summary keeps a missing pr undefined and an unset outcome in progress", () => {
  const { state } = claimAt("spec", { allocated: ALLOCATED });
  const { pr: _pr, ...st } = state;
  const [summary] = summaryOf({
    n: ISSUE,
    st,
    outcome: null,
    reason: null,
  }).items;
  assert.ok(Object.hasOwn(summary, "pr"));
  assert.equal(summary.pr, undefined);
  assert.equal(summary.stage, "spec");
  assert.equal(summary.outcome, "in-progress");
  assert.equal(summary.reason, null);
  assert.equal(summary.allocatedTokens, ALLOCATED);
});
