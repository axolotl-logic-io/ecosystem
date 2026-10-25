// @ts-check
// Issue-execution contention through real job boundaries (#133): built
// `job.mjs` and `ops.mjs` against the full-flow fake GitHub, a real origin
// and fake pi. Gates in the fake GitHub and barriers in fake pi interleave
// the jobs, never sleeps. Two jobs that both request ownership before
// either acquires, on the same lane or on two, start one writer between
// them, and the loser sees a clean refusal rather than the winner's write
// in flight (the shared-journal race). A predecessor delayed in its writer
// session past a successor's confirmation pushes, saves and releases
// nothing. A lost acquisition holds through a restart without a second
// reservation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { armGate } from "./fake-pipeline-flow-gh-gates.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import {
  acquireFor,
  executionRecords,
  releaseOwner,
  startStage,
} from "./pipeline-flow-contention-test-kit.mjs";
import {
  implementorTurn,
  openFlowIssue,
} from "./pipeline-flow-script-test-kit.mjs";
import {
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";

const OWNED = "another invocation owns the issue";
const LOST = /execution ownership lost or unconfirmed/u;
const UNCERTAIN_ACQUIRE = /uncertain acquire; preserve/u;
const RETAINED = /uncertain coordination write retained/u;
const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
// The issue scope as it appears inside a record's JSON body.
const IN_ISSUE = `\\"issue\\",${ISSUE},`;
// The epoch-ref reservation that acquires ownership.
const RESERVE = "\nPOST\nrepos/o/r/git/refs\n";

/**
 * New work on the issue, with the implementor's turns `turns` makes.
 * @param {(flow: import("./pipeline-flow-test-kit.mjs").Flow) => import("./fake-pipeline-flow-pi.mjs").FlowTurn[]} turns
 */
function newWork(turns) {
  const flow = setUpFlow();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, { implementor: turns(flow) });
  return flow;
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @returns {string[]} the roles of the writer sessions that started */
function writerStarts(flow) {
  return piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .map(({ role }) => role);
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @returns {string[]} the state comments' bodies */
function stateComments(flow) {
  return readWorld(flow.ghDir)
    .comments.filter(({ body }) => body.includes("agent-pipeline:state"))
    .map(({ body }) => body);
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {string} name */
function barrierAt(flow, name) {
  return { dir: flow.tmp, name };
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {string} name */
function reached(flow, name) {
  return fs.existsSync(path.join(flow.tmp, `${name}.reached`));
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {string} name */
function open(flow, name) {
  fs.writeFileSync(path.join(flow.tmp, `${name}.open`), "");
}

for (const { where, lanes } of [
  { where: "one lane", lanes: ["L", "L"] },
  { where: "two lanes", lanes: ["L", "M"] },
]) {
  test(`two jobs on ${where} both request before either acquires, and only one starts a writer`, async () => {
    const flow = newWork(() => [
      implementorTurn("Hello, world!", "Greet visitors"),
    ]);
    // Each request's reply waits until both requests are on GitHub, so
    // both jobs' writes are in flight at once.
    armGate(flow.ghDir, {
      name: "requested",
      match: ['"kind":"request"', IN_ISSUE],
      requests: { issue: ISSUE, count: 2 },
      uses: 2,
    });
    const ends = await Promise.all(
      lanes.map((lane) => startStage(flow, "implement", lane)),
    );
    const lines = ends.map(({ line }) => line);
    assert.deepEqual(lines.map(({ end }) => end).sort(), ["next", "unclaimed"]);
    const loser = lines.find(({ end }) => end === "unclaimed");
    assert.equal(loser.reason, OWNED);
    assert.equal(loser.claimError, undefined, "a clean loss, not a hold");
    assert.deepEqual(writerStarts(flow), ["implementor"]);
    const kinds = executionRecords(flow).map(({ kind }) => kind);
    assert.deepEqual(kinds.slice(0, 2), ["request", "request"]);
    assert.equal(kinds.filter((kind) => kind === "confirm").length, 1);
    assert.equal(kinds.filter((kind) => kind === "cancel").length, 1);
  });
}

test("a predecessor delayed past its successor's confirmation pushes, saves and releases nothing", async () => {
  const flow = newWork((made) => [
    {
      ...implementorTurn("Hello, world!", "Greet visitors"),
      barrier: barrierAt(made, "predecessor"),
    },
  ]);
  const predecessor = startStage(flow, "implement", "L");
  await waitFor("the predecessor's writer session is under way", () =>
    reached(flow, "predecessor"),
  );
  // An operator releases the predecessor's ownership, and an invocation on
  // another lane acquires and confirms it.
  const stale = releaseOwner(flow, "L");
  const successor = acquireFor(flow, "M");
  const records = executionRecords(flow);
  assert.deepEqual(
    records.slice(-2).map(({ kind }) => kind),
    ["request", "confirm"],
  );
  const states = stateComments(flow);
  const branch = refIn(flow.origin, BRANCH);
  // The predecessor resumes: its commit's push, its stage-end save and its
  // release each find the issue no longer its own.
  open(flow, "predecessor");
  // It holds rather than release, and exits as a job whose own op failed.
  const late = await predecessor;
  assert.equal(late.code, 1);
  assert.match(late.stderr, LOST);
  // Its commit stays local: the job refused the push it asked for.
  const commits = piLog(flow.piDir).filter((entry) => "committed" in entry);
  assert.equal(commits.length, 1, "the writer committed once");
  assert.equal(commits[0].committed.pushed, "none");
  assert.match(commits[0].committed.pushError, LOST);
  assert.equal(refIn(flow.origin, BRANCH), branch, "nothing pushed");
  assert.deepEqual(stateComments(flow), states, "no state saved");
  // The successor still owns the issue: no record follows its confirmation.
  assert.deepEqual(executionRecords(flow), records);
  assert.equal(records.at(-2)?.identity.instance, successor.instance);
  assert.equal(
    records.filter(({ instance }) => instance === stale).at(-1)?.kind,
    "release",
    "only the operator's release of the predecessor",
  );
  assert.deepEqual(writerStarts(flow), ["implementor"]);
});

test("a lost acquisition holds through a restart, with no second reservation", async () => {
  const flow = newWork(() => [
    implementorTurn("Hello, world!", "Greet visitors"),
  ]);
  armGate(flow.ghDir, { name: "lost", match: [RESERVE], drop: true });
  const first = await startStage(flow, "implement", "L");
  assert.equal(first.line.end, "unclaimed");
  assert.match(String(first.line.claimError), UNCERTAIN_ACQUIRE);
  const journal = path.join(
    flow.root,
    "runs",
    "o__r",
    `issue-${ISSUE}`,
    "coordination-uncertain.json",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(journal, "utf8")).operation,
    "acquire",
  );
  const restarted = await startStage(flow, "implement", "L");
  assert.equal(restarted.line.end, "unclaimed");
  assert.match(String(restarted.line.claimError), RETAINED);
  const reservations = ghCalls(flow.ghDir).filter((args) =>
    args.join("\n").includes(RESERVE.trim()),
  );
  assert.equal(reservations.length, 1, "one reservation, the lost one");
  assert.deepEqual(writerStarts(flow), []);
});
