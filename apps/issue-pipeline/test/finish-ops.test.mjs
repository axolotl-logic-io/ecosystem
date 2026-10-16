// @ts-check
// The ops that finish an issue's sweep or take it out of the pipeline
// (close-parent, post, release), through the ops CLI, and the built ops CLI
// against src/ops.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import {
  ask,
  calls,
  claimListing,
  commentPost,
  fakeGh,
  finishReplies,
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

// The commit prefix the merger comment names.
const SHORT_SHA = 12;
const STILL_WORKING = /\n<sub>Lane still working at <minute>\.<\/sub>$/u;
const STATE_JSON = /<!-- agent-pipeline:state\n(?<json>.*)\n-->/u;
const MERGE_SHA_ERROR = /expectedSha/u;
const MERGED_TRUE = /"merged":true/u;
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
const RELEASED = { ok: true, op: "release", posted: 0 };

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
    { number: 3, state: "closed" },
    { number: OPEN_SUB, state: "open" },
    { number: LAST_OPEN_SUB, state: "open" },
  ];
  const want = {
    ok: true,
    op: "close-parent",
    posted: 0,
    closed: false,
    open: [OPEN_SUB, LAST_OPEN_SUB],
  };
  assert.equal(closeParent(w, JSON.stringify(subs)), replyLine(want));
});

test("close-parent closes a parent whose sub-issues are all closed", () => {
  const w = world();
  const subs = [
    { number: 3, state: "closed" },
    { number: 4, state: "closed" },
  ];
  assert.equal(
    closeParent(w, JSON.stringify(subs)),
    replyLine({
      ok: true,
      op: "close-parent",
      posted: 0,
      closed: true,
    }),
  );
  assert.deepEqual(writes(), [
    commentPost(
      ISSUE,
      signedBy("coordinator", "All sub-issues are closed (#3, #4). Closing."),
    ),
    ["issue", "close", "7", "-R", "o/r"],
    ...relabel(ISSUE, "agent:merged", "agent:split"),
  ]);
});

test("post only posts the queued comments", () => {
  const w = world();
  fakeGh.reply([]);
  const out = ask(w, {
    op: "post",
    comments: [{ number: ISSUE, by: { role: "x" }, body: "b" }],
  });
  assert.equal(out, replyLine({ ok: true, op: "post", posted: 1 }));
  assert.deepEqual(calls(), [commentPost(ISSUE, signedBy("x", "b"))]);
});

// Runs release for #7 with `state`: its reply, the gh writes it made, the
// claim edit's body and the state it wrote.
/** @param {World} w @param {object} state @returns {{ out: string, made: string[][], touched: string, written: unknown }} */
function release(w, state) {
  fakeGh.reply([claimListing(), claimListing()]);
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
  const state = { pr: 50, stage: "review", lease };
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
  const reply = FAILED_REPLY.parse(
    JSON.parse(
      ask(w, { op: "merge", number: ISSUE, state: { pr: 50, stage: "merge" } }),
    ),
  );
  assert.equal(reply.ok, false);
  assert.match(reply.error, MERGE_SHA_ERROR);
  const merges = calls().filter((args) => args.join(" ").includes("pr merge"));
  assert.deepEqual(merges, []);
});

test("the built ops merges and releases as src/ops.ts does", () => {
  const out = fs.mkdtempSync("/tmp/issue-pipeline-built-ops-");
  process.on("exit", () => fs.rmSync(out, { recursive: true, force: true }));
  const build = new URL("../build.ts", import.meta.url).pathname;
  const built = spawnSync(process.execPath, [build, out], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const lease = { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) };
  const state = { pr: 50, stage: "merge", lease };
  /** @type {{ merged: string, mergeCalls: string[], released: string, releaseCalls: string[][] }[]} */
  const answers = [];
  for (const ops of [undefined, path.join(out, "ops.mjs")]) {
    const w = world();
    const view = JSON.stringify({
      headRefOid: w.sha,
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      isDraft: false,
    });
    fakeGh.reply([{ when: "pr view", stdout: view }, ...finishReplies()]);
    const req = { op: "merge", number: ISSUE, state, expectedSha: w.sha };
    const merged = ask(w, req, ops);
    // Each world's commit has its own sha: the full one, then its short form.
    const mergeCalls = calls().map((args) =>
      args
        .join(" ")
        .replaceAll(w.sha, "<sha>")
        .replaceAll(w.sha.slice(0, SHORT_SHA), "<sha>"),
    );
    fakeGh.reply([claimListing(), claimListing()]);
    const unleased = { ...state, lease: null };
    const released = ask(
      w,
      { op: "release", number: ISSUE, state: unleased },
      ops,
    );
    answers.push({ merged, mergeCalls, released, releaseCalls: calls() });
  }
  const [first, second] = answers;
  assert.ok(first);
  assert.match(first.merged, MERGED_TRUE);
  assert.deepEqual(second, first);
});

test("release writes a missing lease as null", () => {
  const w = world();
  const state = { pr: 50, stage: "review", lease: null };
  const { out, made, touched, written } = release(w, state);
  assert.equal(out, replyLine(RELEASED));
  assert.match(touched, STILL_WORKING);
  assert.equal(made.length, RELEASE_WRITES);
  assert.equal(JSON.stringify(written), JSON.stringify(state));
});
