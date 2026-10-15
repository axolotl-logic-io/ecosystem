// The ops that finish an issue's sweep or take it out of the pipeline
// (close-parent, post, release), through the ops CLI, and the modules that
// hold them and merge.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  ask,
  assertReply,
  calls,
  claimListing,
  commentPost,
  fakeGh,
  finishReplies,
  hoursFromNow,
  LANE,
  listCall,
  relabel,
  SWEEP,
  signedBy,
  world,
} from "./ops-test-kit.mjs";

// The commit prefix the merger comment names.
const SHORT_SHA = 12;
const STILL_WORKING = /\n<sub>Lane still working at <minute>\.<\/sub>$/u;
const STATE_JSON = /<!-- agent-pipeline:state\n(?<json>.*)\n-->/u;

function closeParent(w, subs) {
  fakeGh.reply([{ when: "sub_issues", stdout: subs }]);
  return ask(w, { op: "close-parent", number: 7 });
}

test("the moved ops live in src/ops/merge.ts and src/ops/finish.ts", async () => {
  const { merge } = await import("../src/ops/merge.ts");
  const finish = await import("../src/ops/finish.ts");
  assert.equal(typeof merge, "function");
  for (const name of ["finishMerged", "closeParent", "post", "release"]) {
    assert.equal(typeof finish[name], "function", name);
  }
  assert.deepEqual(finish.post(), {});
});

test("close-parent with no sub-issues closes nothing", () => {
  const w = world();
  for (const subs of ["[]", ""]) {
    assertReply(closeParent(w, subs), {
      ok: true,
      op: "close-parent",
      posted: 0,
      closed: false,
      reason: "no sub-issues found",
    });
  }
  assert.deepEqual(calls(), [
    ["api", "repos/o/r/issues/7/sub_issues?per_page=100"],
  ]);
});

test("close-parent with open sub-issues names them", () => {
  const w = world();
  const subs = [
    { number: 3, state: "closed" },
    { number: 4, state: "open" },
    { number: 5, state: "open" },
  ];
  assertReply(closeParent(w, JSON.stringify(subs)), {
    ok: true,
    op: "close-parent",
    posted: 0,
    closed: false,
    open: [4, 5],
  });
});

test("close-parent closes a parent whose sub-issues are all closed", () => {
  const w = world();
  const subs = [
    { number: 3, state: "closed" },
    { number: 4, state: "closed" },
  ];
  assertReply(closeParent(w, JSON.stringify(subs)), {
    ok: true,
    op: "close-parent",
    posted: 0,
    closed: true,
  });
  assert.deepEqual(calls(), [
    ["api", "repos/o/r/issues/7/sub_issues?per_page=100"],
    commentPost(
      7,
      signedBy("coordinator", "All sub-issues are closed (#3, #4). Closing."),
    ),
    ["issue", "close", "7", "-R", "o/r"],
    ...relabel(7, "agent:merged", "agent:split"),
  ]);
});

test("post only posts the queued comments", () => {
  const w = world();
  fakeGh.reply([]);
  const out = ask(w, {
    op: "post",
    comments: [{ number: 7, by: { role: "x" }, body: "b" }],
  });
  assertReply(out, { ok: true, op: "post", posted: 1 });
  assert.deepEqual(calls(), [commentPost(7, signedBy("x", "b"))]);
});

// Runs release for #7 with `state` and returns the state it wrote.
function release(w, state) {
  fakeGh.reply([claimListing(), claimListing()]);
  const out = ask(w, {
    op: "release",
    number: 7,
    lane: LANE,
    sweepId: SWEEP,
    state,
  });
  assertReply(out, { ok: true, op: "release", posted: 0 });
  const made = calls();
  assert.deepEqual(made[0], listCall(7));
  assert.deepEqual(made[2], listCall(7));
  assert.match(made[3].at(-2), STILL_WORKING);
  assert.equal(made.length, 4);
  const { json } = STATE_JSON.exec(made[1].at(-2)).groups;
  return JSON.parse(json);
}

test("release renews the lease's time, keeps its lane and touches the claim", () => {
  const w = world();
  const before = Date.now();
  const lease = { lane: LANE, sweepId: SWEEP, at: hoursFromNow(-2) };
  const state = { pr: 50, stage: "review", lease };
  const written = release(w, state);
  assert.ok(Date.parse(written.lease.at) >= before);
  assert.equal(
    JSON.stringify(written),
    JSON.stringify({ ...state, lease: { ...lease, at: written.lease.at } }),
  );
});

test("merge without expectedSha answers ok:false and merges nothing", () => {
  const w = world();
  fakeGh.reply([]);
  const reply = JSON.parse(
    ask(w, { op: "merge", number: 7, state: { pr: 50, stage: "merge" } }),
  );
  assert.equal(reply.ok, false);
  assert.match(reply.error, /expectedSha/u);
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
    const req = { op: "merge", number: 7, state, expectedSha: w.sha };
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
    const released = ask(w, { op: "release", number: 7, state: unleased }, ops);
    answers.push({ merged, mergeCalls, released, releaseCalls: calls() });
  }
  assert.match(answers[0].merged, /"merged":true/u);
  assert.deepEqual(answers[1], answers[0]);
});

test("release writes a missing lease as null", () => {
  const w = world();
  const state = { pr: 50, stage: "review", lease: null };
  assert.equal(JSON.stringify(release(w, state)), JSON.stringify(state));
});
