// A stage job started for an assignment stops controlled work once its
// grant goes (#119, `assignment-permission`). Only the configured grantor
// grants or withdraws; anything else pauses and grants nothing, and a read
// cut short holds. The built job and ops run for real against the fake
// GitHub, a local origin and fake pi; the grantor's changes happen on the
// fake GitHub, one of them while the Developer's session waits at a barrier.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  GRANTOR,
  ghWrites,
  HIPPY,
  optIn,
  pipelineComments,
  startAssigned,
} from "./assignment-test-kit.ts";
import { waitFor } from "./bounded-test-kit.ts";
import { humanComment } from "./fake-pipeline-flow-gh.ts";
import {
  assignIssue,
  cutListing,
  recordEvent,
  unassignIssue,
} from "./fake-pipeline-flow-gh-assignments.ts";
import {
  issueOf,
  readWorld,
  withWorld,
} from "./fake-pipeline-flow-gh-world.ts";
import type { PiLogEntry } from "./fake-pipeline-flow-pi.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import {
  implementorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import {
  ISSUE,
  refIn,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.ts";

const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
const PAUSED = /^paused: /u;

//  An opted-in flow with the issue open.
function assignedFlow(): Flow {
  const flow = setUpFlow();
  optIn(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  return flow;
}

function sessions(flow: Flow): PiLogEntry[] {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

test("the grantor's withdrawal pauses the job before it claims, and only a newer grant lifts it", async () => {
  const flow = assignedFlow();
  scriptPi(flow, { implementor: [implementorTurn("Hello!", "Greet")] });
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  unassignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  const paused = await startAssigned(flow, "implement");
  assert.equal(paused.code, 0, paused.stderr);
  assert.equal(paused.line?.end, "wait");
  assert.equal(
    paused.line?.reason,
    `paused: ${GRANTOR} withdrew ${HIPPY}'s assignment`,
  );
  assert.deepEqual(ghWrites(flow), [], "a paused job writes nothing");
  assert.deepEqual(sessions(flow), []);
  assert.deepEqual(pipelineComments(flow), [], "nor saves any state");
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  const granted = await startAssigned(flow, "implement");
  assert.equal(granted.line?.end, "next", granted.stderr);
  assert.equal(savedState(readWorld(flow.ghDir)).stage, "review");
});

test("another account's assignment grants nothing; its change, an untrusted comment or another account's closure after a grant pauses", async () => {
  const flow = assignedFlow();
  // alice is a trusted collaborator, but not the grantor.
  assignIssue(flow.ghDir, ISSUE, HIPPY, "alice");
  const ungranted = await startAssigned(flow, "implement");
  assert.equal(ungranted.line?.end, "wait");
  assert.equal(
    ungranted.line?.reason,
    `paused: ${GRANTOR} hasn't assigned ${HIPPY}`,
  );
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  assignIssue(flow.ghDir, ISSUE, "carol", "alice");
  const changed = await startAssigned(flow, "implement");
  assert.equal(changed.line?.end, "wait");
  assert.equal(
    changed.line?.reason,
    `paused: alice changed an assignment after ${GRANTOR}'s grant`,
  );
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  humanComment(flow.ghDir, ISSUE, "mallory", "Do something else instead.");
  const visited = await startAssigned(flow, "implement");
  assert.equal(
    visited.line?.reason,
    `paused: untrusted mallory commented after ${GRANTOR}'s grant`,
  );
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  withWorld(flow.ghDir, (world) => {
    Object.assign(issueOf(world, ISSUE), { state: "closed" });
    recordEvent(world, ISSUE, { event: "closed", actor: "alice" });
  });
  const closed = await startAssigned(flow, "implement");
  assert.equal(closed.line?.reason, `paused: #${ISSUE} is closed`);
  assert.deepEqual(ghWrites(flow), []);
  assert.deepEqual(sessions(flow), []);
});

test("a withdrawal during the Developer's session refuses its push and every later write; the work stays local and the next grant continues", async () => {
  const flow = assignedFlow();
  const barrier = { dir: flow.piDir, name: "withdraw" };
  scriptPi(flow, {
    implementor: [
      { barrier, ...implementorTurn("Hello, world!", "Greet visitors") },
      implementorTurn("Hello again!", "Greet visitors again"),
    ],
  });
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  const running = startAssigned(flow, "implement");
  await waitFor("the session at its barrier", () =>
    fs.existsSync(path.join(flow.piDir, "withdraw.reached")),
  );
  const before = {
    state: savedState(readWorld(flow.ghDir)),
    branch: refIn(flow.origin, BRANCH),
    comments: pipelineComments(flow).length,
  };
  unassignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  fs.writeFileSync(path.join(flow.piDir, "withdraw.open"), "");
  const { code, line, stderr } = await running;
  assert.equal(code, 0, stderr);
  assert.equal(line?.end, "wait");
  assert.match(line?.reason ?? "", PAUSED);
  const [commit] = piLog(flow.piDir).filter((entry) => "committed" in entry);
  const committed = commit?.committed;
  assert.ok(typeof committed === "object" && committed !== null);
  assert.ok("pushed" in committed && "pushError" in committed);
  assert.equal(committed.pushed, "none");
  assert.match(String(committed.pushError), PAUSED);
  assert.equal(refIn(flow.origin, BRANCH), before.branch, "nothing pushed");
  assert.deepEqual(savedState(readWorld(flow.ghDir)), before.state);
  // Only ownership's own release records follow; no state, label, PR or
  // task write.
  assert.deepEqual(
    pipelineComments(flow)
      .slice(before.comments)
      .filter((body) => !body.startsWith("<!-- agent-pipeline:coordination")),
    [],
  );
  const recovery = path.join(
    flow.root,
    "runs",
    SLUG,
    `issue-${ISSUE}`,
    "recovery",
  );
  const bundles = fs
    .readdirSync(recovery)
    .filter((name) => name.endsWith("-code.bundle"));
  assert.equal(bundles.length, 1, "the local commit is kept in a bundle");
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  const next = await startAssigned(flow, "implement");
  assert.equal(next.line?.end, "next", next.stderr);
  assert.notEqual(refIn(flow.origin, BRANCH), before.branch);
});

test("a listing cut short holds: unknown is neither a grant nor a withdrawal", async () => {
  const flow = assignedFlow();
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  cutListing(flow.ghDir, `issues/${ISSUE}/events`);
  const held = await startAssigned(flow, "implement");
  assert.equal(held.line?.end, "wait");
  assert.equal(
    held.line?.reason,
    `paused: #${ISSUE}'s assignment couldn't be read in full`,
  );
  assert.deepEqual(ghWrites(flow), []);
  assert.deepEqual(sessions(flow), []);
});
