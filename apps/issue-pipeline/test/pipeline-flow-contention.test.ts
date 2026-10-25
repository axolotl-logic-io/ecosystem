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
import { waitFor } from "./bounded-test-kit.ts";
import { ghCalls } from "./fake-pipeline-flow-gh.ts";
import { armGate } from "./fake-pipeline-flow-gh-gates.ts";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import type { FlowTurn } from "./fake-pipeline-flow-pi.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import {
  acquireFor,
  executionRecords,
  releaseOwner,
  startStage,
} from "./pipeline-flow-contention-test-kit.ts";
import {
  implementorTurn,
  openFlowIssue,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { ISSUE, refIn, scriptPi, setUpFlow } from "./pipeline-flow-test-kit.ts";

const OWNED = "another invocation owns the issue";
const LOST = /execution ownership lost or unconfirmed/u;
const UNCERTAIN_ACQUIRE = /uncertain acquire; preserve/u;
const RETAINED = /uncertain coordination write retained/u;
const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
// The issue scope as it appears inside a record's JSON body.
const IN_ISSUE = `\\"issue\\",${ISSUE},`;
// The epoch-ref reservation that acquires ownership.
const RESERVE = "\nPOST\nrepos/o/r/git/refs\n";

// New work on the issue, with the implementor's turns `turns` makes.
function newWork(turns: (flow: Flow) => FlowTurn[]): Flow {
  const flow = setUpFlow();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, { implementor: turns(flow) });
  return flow;
}

// Returns the roles of the writer sessions that started
function writerStarts(flow: Flow): string[] {
  return piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .map(({ role }) => role);
}

// Returns the state comments' bodies
function stateComments(flow: Flow): string[] {
  return readWorld(flow.ghDir)
    .comments.filter(({ body }) => body.includes("agent-pipeline:state"))
    .map(({ body }) => body);
}

function barrierAt(flow: Flow, name: string): { dir: string; name: string } {
  return { dir: flow.tmp, name };
}

function reached(flow: Flow, name: string): boolean {
  return fs.existsSync(path.join(flow.tmp, `${name}.reached`));
}

function open(flow: Flow, name: string): void {
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
    assert.deepEqual(lines.map((line) => line?.end).sort(), [
      "next",
      "unclaimed",
    ]);
    const loser = lines.find((line) => line?.end === "unclaimed");
    assert.ok(loser !== undefined && loser !== null);
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
  const committed = commits[0]?.committed;
  assert.ok(typeof committed === "object" && committed !== null);
  assert.ok("pushed" in committed && "pushError" in committed);
  assert.equal(committed.pushed, "none");
  assert.match(String(committed.pushError), LOST);
  assert.equal(refIn(flow.origin, BRANCH), branch, "nothing pushed");
  assert.deepEqual(stateComments(flow), states, "no state saved");
  // The successor still owns the issue: no record follows its confirmation.
  assert.deepEqual(executionRecords(flow), records);
  const confirmed = records.at(-2);
  assert.ok(confirmed?.kind === "request");
  assert.equal(confirmed.identity.instance, successor.instance);
  assert.equal(
    records
      .filter((record) => "instance" in record && record.instance === stale)
      .at(-1)?.kind,
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
  assert.equal(first.line?.end, "unclaimed");
  assert.match(String(first.line?.claimError), UNCERTAIN_ACQUIRE);
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
  assert.equal(restarted.line?.end, "unclaimed");
  assert.match(String(restarted.line?.claimError), RETAINED);
  const reservations = ghCalls(flow.ghDir).filter((args) =>
    args.join("\n").includes(RESERVE.trim()),
  );
  assert.equal(reservations.length, 1, "one reservation, the lost one");
  assert.deepEqual(writerStarts(flow), []);
});
