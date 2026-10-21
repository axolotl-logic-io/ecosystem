// @ts-check
// New work through built jobs/ops, with real local git and fake services.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.mjs";
import {
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import { scriptPi, setUpFlow } from "./pipeline-flow-test-kit.mjs";

/** @type {import("./pipeline-flow-test-kit.mjs").Flow} */
let flow;
before(() => {
  flow = setUpFlow();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    reviewer: [hardeningTurn(), securityTurn()],
  });
});
after(() => stopJobs(flow));

/** @param {string} stage */
function completeStage(stage) {
  const line = runStage(flow, stage);
  return { line, state: savedState(readWorld(flow.ghDir)) };
}

for (const stage of ["implement", "review", "merge"]) {
  test(`direct new work completes ${stage} without Author or Gherkin`, () => {
    const { line, state } = completeStage(stage);
    assert.equal(line.end, "next");
    assert.equal(state.authorUsed, false);
    assert.equal(state.gherkin, null);
    assert.ok(state.requirementsInputs);
  });
}

test("direct work closes only after checks and Security, with unchanged writer and token boundaries", () => {
  const world = readWorld(flow.ghDir);
  const state = savedState(world);
  assert.equal(state.stage, "done");
  assert.ok(state.hardened);
  assert.deepEqual(state.security.revision, state.merged);
  assert.equal(world.issues[0]?.state, "closed");
  assert.deepEqual(world.unsupported, []);
  assert.equal(
    world.comments.some(({ body }) => body.includes("role=author")),
    false,
  );
  const starts = piLog(flow.piDir).filter((entry) => entry.start === true);
  assert.deepEqual(
    starts.map(({ role }) => role),
    ["implementor", "reviewer", "reviewer"],
  );
  assert.deepEqual(
    starts.map(({ ghToken }) => ghToken),
    [null, null, null],
  );
  assert.deepEqual(
    starts.map(({ commitScope }) => commitScope),
    [true, true, false],
  );
  assert.equal(
    starts.at(-1)?.extensions.includes("pipeline-commit.mjs"),
    false,
  );
});
