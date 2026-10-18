// @ts-check
// The ops that finish an issue's job or take it out of the pipeline
// (close-parent, post, release), through the ops CLI on version 2 states,
// and the built ops CLI against src/ops.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  ask,
  calls,
  claimListing,
  commentPost,
  fakeGh,
  hoursFromNow,
  LANE,
  relabel,
  replyLine,
  SWEEP,
  signedBy,
  world,
  writes,
} from "./ops-test-kit.mjs";

/** @import { World } from "./ops-test-kit.mjs" */

const { newIssueState } = await import("../src/state.ts");

const STILL_WORKING = /\n<sub>Lane still working at <minute>\.<\/sub>$/u;
const STATE_JSON = /<!-- agent-pipeline:state\n(?<json>.*)\n-->/u;
const MERGE_SHA_ERROR = /expectedSha/u;
// The issue every test works on.
const ISSUE = 7;
// The sub-issues still open in the open-sub-issues case.
const OPEN_SUB = 4;
const LAST_OPEN_SUB = 5;
// How old the lease release renews is, and the gh writes release makes: the
// state comment and the claim touch.
const LEASE_AGE_HOURS = 2;
const RELEASE_WRITES = 2;
const STATE_GROUPS = z.object({ json: z.string() });
const LEASED = z.looseObject({ lease: z.looseObject({ at: z.string() }) });
const FAILED_REPLY = z.object({ ok: z.boolean(), error: z.string() });
const RELEASED = { ok: true, op: "release", posted: 0, commentIds: [] };
// The id GitHub gives the comment post posts.
const POSTED_ID = 901;
const PR = 50;
// Issue #7's version 2 state with `extra` over a new issue's.
/** @param {object} extra @returns {Record<string, unknown>} */
function issueState(extra) {
  return { ...newIssueState(ISSUE), ...extra };
}

/** @param {World} w @param {string} subs @returns {string} */
function closeParent(w, subs) {
  fakeGh.reply([{ when: "sub_issues", stdout: subs }]);
  return ask(w, { op: "close-parent", number: ISSUE });
}

test("close-parent with no sub-issues closes nothing", () => {
  const w = world();
  for (const subs of ["[]", ""]) {
    assert.equal(
      closeParent(w, subs),
      replyLine({
        ok: true,
        op: "close-parent",
        posted: 0,
        commentIds: [],
        closed: false,
        reason: "no sub-issues found",
      }),
    );
  }
  assert.deepEqual(writes(), []);
});

test("close-parent with open sub-issues names them", () => {
  const w = world();
  const subs = [
    { number: 3, state: "closed", reason: "completed", labels: [] },
    { number: OPEN_SUB, state: "open", reason: null, labels: [] },
    { number: LAST_OPEN_SUB, state: "open", reason: null, labels: [] },
  ];
  const want = {
    ok: true,
    op: "close-parent",
    posted: 0,
    commentIds: [],
    closed: false,
    open: [OPEN_SUB, LAST_OPEN_SUB],
  };
  assert.equal(closeParent(w, JSON.stringify(subs)), replyLine(want));
});

test("close-parent closes a parent whose sub-issues are all closed and one merged, then relabels it, then comments", () => {
  const w = world();
  const subs = [
    { number: 3, state: "closed", reason: "completed", labels: [] },
    { number: 4, state: "closed", reason: "not_planned", labels: [] },
  ];
  assert.equal(
    closeParent(w, JSON.stringify(subs)),
    replyLine({
      ok: true,
      op: "close-parent",
      posted: 0,
      commentIds: [],
      closed: true,
    }),
  );
  assert.deepEqual(writes(), [
    ["issue", "close", "7", "-R", "o/r"],
    ...relabel(ISSUE, "agent:merged", "agent:split"),
    commentPost(
      ISSUE,
      signedBy("coordinator", "All sub-issues are closed (#3, #4). Closing."),
    ),
  ]);
});

test("close-parent counts a sub-issue labelled agent:merged as merged", () => {
  const w = world();
  const subs = [
    { number: 3, state: "closed", reason: null, labels: ["agent:merged"] },
  ];
  assert.equal(
    closeParent(w, JSON.stringify(subs)),
    replyLine({
      ok: true,
      op: "close-parent",
      posted: 0,
      commentIds: [],
      closed: true,
    }),
  );
});

test("close-parent leaves a parent open when its sub-issues are all closed but none merged", () => {
  const w = world();
  const subs = [
    { number: 3, state: "closed", reason: "not_planned", labels: [] },
    { number: 4, state: "closed", reason: null, labels: ["agent:split"] },
  ];
  assert.equal(
    closeParent(w, JSON.stringify(subs)),
    replyLine({
      ok: true,
      op: "close-parent",
      posted: 0,
      commentIds: [],
      closed: false,
      reason: "no sub-issue merged",
    }),
  );
  assert.deepEqual(writes(), []);
});

test("post only posts the queued comments and replies with the ids GitHub gave", () => {
  const w = world();
  fakeGh.reply([
    { when: `issues/${ISSUE}/comments -f`, stdout: `${POSTED_ID}\n` },
  ]);
  const out = ask(w, {
    op: "post",
    comments: [{ number: ISSUE, by: { role: "x" }, body: "b" }],
  });
  assert.equal(
    out,
    replyLine({ ok: true, op: "post", posted: 1, commentIds: [POSTED_ID] }),
  );
  assert.deepEqual(calls(), [
    [
      "api",
      "-X",
      "POST",
      `repos/o/r/issues/${ISSUE}/comments`,
      "-f",
      `body=${signedBy("x", "b")}`,
      "--jq",
      ".id",
    ],
  ]);
});

// Runs release for #7 with `state`: its reply, the gh writes it made, the
// claim edit's body and the state it wrote.
/** @param {World} w @param {object} state @returns {{ out: string, made: string[][], touched: string, written: unknown }} */
function release(w, state) {
  fakeGh.reply([claimListing(), claimListing(), claimListing()]);
  const out = ask(w, {
    op: "release",
    number: ISSUE,
    lane: LANE,
    sweepId: SWEEP,
    state,
  });
  const made = writes();
  const [stateWrite = [], claimTouch = []] = made;
  const { json } = STATE_GROUPS.parse(
    STATE_JSON.exec(stateWrite.at(-2) ?? "")?.groups,
  );
  return {
    out,
    made,
    touched: claimTouch.at(-2) ?? "",
    written: JSON.parse(json),
  };
}

test("release renews the lease's time, keeps its lane and touches the claim", () => {
  const w = world();
  const before = Date.now();
  const lease = {
    lane: LANE,
    sweepId: SWEEP,
    at: hoursFromNow(-LEASE_AGE_HOURS),
  };
  const state = issueState({ stage: "review", pr: PR, lease });
  const { out, made, touched, written } = release(w, state);
  assert.equal(out, replyLine(RELEASED));
  assert.match(touched, STILL_WORKING);
  assert.equal(made.length, RELEASE_WRITES);
  const { at } = LEASED.parse(written).lease;
  assert.ok(Date.parse(at) >= before);
  assert.equal(
    JSON.stringify(written),
    JSON.stringify({ ...state, lease: { ...lease, at } }),
  );
});

test("merge without expectedSha answers ok:false and merges nothing", () => {
  const w = world();
  fakeGh.reply([]);
  const state = issueState({ stage: "merge", pr: PR });
  const reply = FAILED_REPLY.parse(
    JSON.parse(ask(w, { op: "merge", number: ISSUE, state })),
  );
  assert.equal(reply.ok, false);
  assert.match(reply.error, MERGE_SHA_ERROR);
  const merges = calls().filter((args) => args.join(" ").includes("pr merge"));
  assert.deepEqual(merges, []);
});

test("release writes a missing lease as null", () => {
  const w = world();
  const state = issueState({ stage: "review", pr: PR, lease: null });
  const { out, made, touched, written } = release(w, state);
  assert.equal(out, replyLine(RELEASED));
  assert.match(touched, STILL_WORKING);
  assert.equal(made.length, RELEASE_WRITES);
  assert.equal(JSON.stringify(written), JSON.stringify(state));
});
