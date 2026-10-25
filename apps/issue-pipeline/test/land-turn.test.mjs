// @ts-check
// The target's integration turn around exact Land (#171), with Lands of
// issues 7, 8 and 9 on one target, each a fresh built ops process under its
// own confirmed issue execution, against the full-flow fake GitHub and a
// real origin. Gates in the fake GitHub hold a Land at a chosen call, so the
// Lands interleave by barrier, not by timing. Only the turn's owner writes
// the target; a waiting Land cancels its request and writes nothing else;
// the turn is read afresh from GitHub, so deleting every local run folder
// changes nothing; an uncertain turn write holds without a second POST; and
// a dead owner's turn is retired only by a later invocation of its own
// issue, after which its late release is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import {
  armGate,
  gateReached,
  openGate,
} from "./fake-pipeline-flow-gh-gates.mjs";
import {
  contenders,
  landing,
  prWrites,
  turnRecords,
  turnView,
} from "./land-turn-test-kit.mjs";
import { recordKindsOn, statusOf } from "./task-results-test-kit.mjs";

const PREDECESSOR = new URL("./fake-turn-predecessor.mjs", import.meta.url)
  .pathname;
// The integration scope as it appears inside a record's JSON body.
const IN_TURN = '\\"integration\\"]';
const RETAINED = /uncertain coordination write retained/u;
const LOST = /execution ownership lost or unconfirmed/u;
const KILLED = /ops exited null/u;

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {number} issue @returns {string} */
function runDir(flow, issue) {
  return path.join(flow.root, "runs", "o__r", `issue-${issue}`);
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @returns {[string, number][]} each turn record's kind and issue */
function byIssue(flow) {
  const rows = turnRecords(flow);
  return rows.map((row) => {
    const request = rows.find(({ id }) => id === (row.request ?? row.id));
    return [row.kind, request.identity.issue];
  });
}

// A Land under the turn that approved its PR and is about to record its
// merge attempt: none of its writes is in flight.
function attempting() {
  return {
    name: "attempting",
    match: ["agent-pipeline:state", '"mergeAttempt":{', '"result":null'],
    before: true,
  };
}

/** @param {import("./land-turn-test-kit.mjs").Contender} each @param {number} from @returns {string[][]} its PR's writes since `from` */
function writesTo(each, from) {
  return prWrites(each.flow.ghDir, from).filter((args) =>
    args.some((arg) => arg.includes(`/${each.ready.pr}`)),
  );
}

test("one Land holds the target's turn; later Lands wait in order, read afresh from GitHub, and write nothing", async () => {
  const [first, second, third] = contenders();
  const { flow } = first;
  const from = ghCalls(flow.ghDir).length;
  // Issue 7's Land holds the turn, has approved its PR, and is about to
  // record its merge attempt: no write of it is in flight.
  armGate(flow.ghDir, attempting());
  const firstLand = landing(first);
  await waitFor("issue 7's Land is about to push under the turn", () =>
    gateReached(flow.ghDir, "attempting"),
  );
  // Issue 8's Land saw the turn held and is about to cancel its request.
  armGate(flow.ghDir, {
    name: "cancelling",
    match: ['"kind":"cancel"', IN_TURN],
    before: true,
  });
  const secondLand = landing(second);
  await waitFor("issue 8's Land is about to cancel", () =>
    gateReached(flow.ghDir, "cancelling"),
  );
  assert.deepEqual(turnView(flow).open, [first.issue, second.issue]);
  // Nothing local holds the turn: with the run folders gone (all but issue
  // 8's, whose cancel is in flight), issue 9's Land reads the owner and the
  // order ahead of it from GitHub.
  for (const each of [first, third]) {
    fs.rmSync(runDir(flow, each.issue), { recursive: true, force: true });
  }
  const thirdReply = await landing(third);
  assert.partialDeepStrictEqual(thirdReply, {
    merged: false,
    reason: "integration-turn",
  });
  assert.equal(
    thirdReply.detail,
    "issue #7 holds the target's integration turn; ahead of this Land: #7, #8",
  );
  openGate(flow.ghDir, "cancelling");
  assert.partialDeepStrictEqual(await secondLand, {
    merged: false,
    reason: "integration-turn",
  });
  openGate(flow.ghDir, "attempting");
  const landed = await firstLand;
  assert.equal(landed.merged, true, JSON.stringify(landed));
  assert.equal(first.remoteTarget(), first.revision);
  for (const waiting of [second, third]) {
    assert.deepEqual(writesTo(waiting, from), [], "no approval or merge");
    assert.equal(
      statusOf(flow, waiting.issue, waiting.bound("Land")).status,
      "missing",
    );
  }
  const [a, b, c] = [first.issue, second.issue, third.issue];
  assert.deepEqual(byIssue(flow), [
    ["request", a],
    ["confirm", a],
    ["request", b],
    ["request", c],
    ["cancel", c],
    ["cancel", b],
    ["release", a],
  ]);
  assert.deepEqual(turnView(flow), { open: [], ended: [a, b, c] });
});

test("a lost turn confirmation holds the turn and the issue, and nothing sends it again", async () => {
  const [first, second] = contenders();
  const { flow } = first;
  const kinds = recordKindsOn(flow.ghDir, first.issue);
  armGate(flow.ghDir, {
    name: "lost",
    match: ['"kind":"confirm"', IN_TURN],
    drop: true,
  });
  // The confirmation and its reply are lost after the epoch ref reserved
  // the turn: the Land can't establish it, keeps the journal and stops, and
  // the job's own release of the issue then holds on that journal.
  await assert.rejects(landing(first), RETAINED);
  assert.equal(first.remoteTarget(), first.start);
  assert.deepEqual(recordKindsOn(flow.ghDir, first.issue), kinds, "no attempt");
  const journal = path.join(
    runDir(flow, first.issue),
    "coordination-uncertain.json",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(journal, "utf8")).operation,
    "confirm",
  );
  assert.deepEqual(turnView(flow).open, [first.issue]);
  // The reserved turn holds: issue 8's Land waits behind it, writing nothing.
  const from = ghCalls(flow.ghDir).length;
  const waited = await landing(second);
  assert.equal(
    waited.detail,
    "issue #7 holds the target's integration turn; ahead of this Land: #7",
  );
  assert.deepEqual(writesTo(second, from), []);
  // A retry of issue 7 acquires nothing, so it can't send the confirmation
  // again.
  assert.throws(() => landing(first), RETAINED);
  const confirms = ghCalls(flow.ghDir).filter((args) =>
    args.some(
      (arg) => arg.includes('"kind":"confirm"') && arg.includes(IN_TURN),
    ),
  );
  assert.equal(confirms.length, 1, "one confirmation POST, the lost one");
  assert.equal(
    JSON.parse(fs.readFileSync(journal, "utf8")).operation,
    "confirm",
  );
});

test("a dead Land's turn holds until its own issue's retry retires it; its late release is refused", async () => {
  const [first, second] = contenders();
  const { flow } = first;
  // Issue 7's Land dies holding the confirmed turn, just before its attempt.
  armGate(flow.ghDir, {
    name: "died",
    match: ["agent-pipeline:task-result", '"kind":"attempt"'],
    before: true,
    kill: true,
  });
  await assert.rejects(landing(first), KILLED);
  const [dead] = turnRecords(flow);
  assert.equal(dead.identity.issue, first.issue);
  assert.deepEqual(turnView(flow).open, [first.issue]);
  // Another issue's Land can't take the turn from it.
  const waited = await landing(second);
  assert.equal(
    waited.detail,
    "issue #7 holds the target's integration turn; ahead of this Land: #7",
  );
  // Issue 7's retry finds no unsettled Land, retires the dead request and
  // lands; it holds the turn, about to record its merge attempt.
  armGate(flow.ghDir, attempting());
  const retry = landing(first);
  await waitFor("the retry is about to push under the turn", () =>
    gateReached(flow.ghDir, "attempting"),
  );
  const retired = turnRecords(flow).find(
    ({ kind, request }) => kind === "release" && request === dead.id,
  );
  assert.ok(retired, "the dead request is released");
  const successor = turnRecords(flow).findLast(
    ({ kind, identity }) =>
      kind === "request" && identity.issue === first.issue,
  );
  assert.deepEqual(retired.evidence, {
    retiredBy: successor.identity.instance,
  });
  // The dead invocation's late release clears nothing and writes nothing.
  const before = turnRecords(flow);
  const calls = ghCalls(flow.ghDir).length;
  const late = spawnSync(process.execPath, [PREDECESSOR], {
    input: JSON.stringify({
      config: flow.config,
      number: first.issue,
      execution: dead.identity,
      checkout: {
        issue: first.issue,
        dir: path.join(flow.root, "work", "o__r", `issue-${first.issue}`),
        branch: first.branch,
      },
    }),
    encoding: "utf8",
    env: flow.env,
  });
  assert.match(JSON.parse(late.stdout).refused, LOST, late.stderr);
  assert.deepEqual(turnRecords(flow), before);
  assert.deepEqual(
    ghCalls(flow.ghDir)
      .slice(calls)
      .filter((args) => args.includes("-X")),
    [],
  );
  openGate(flow.ghDir, "attempting");
  const landed = await retry;
  assert.equal(landed.merged, true, JSON.stringify(landed));
  assert.equal(first.remoteTarget(), first.revision);
  assert.deepEqual(turnView(flow), {
    open: [],
    ended: [first.issue, second.issue, first.issue],
  });
});
