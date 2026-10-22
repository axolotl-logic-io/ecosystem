// @ts-check
// Closed own-merge recovery must preserve merged truth on failed safety gates.
// After Land it confirms read-only (#185): no suite, Security session or writer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";
import { readWorld, writeWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  createReplayFlow,
  expectedReplay,
  merges,
  replayFacts,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import { scriptPi, setUpFlow } from "./pipeline-flow-test-kit.mjs";

/** @type {import("./pipeline-flow-test-kit.mjs").Flow} */
let flow;
/** @type {import("./fake-pipeline-flow-gh-world.mjs").World} */
let interruptedWorld;
before(() => {
  flow = setUpFlow();
  ({ interruptedWorld } = createReplayFlow(flow));
});
beforeEach(() => {
  writeWorld(flow.ghDir, structuredClone(interruptedWorld));
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
});
after(() => stopJobs(flow));

test("closed recovery without premerge Security stops read-only: no fresh Security session can review or reroll it", () => {
  scriptPi(flow, {
    reviewer: [
      {
        output: {
          summary: "Unsafe result",
          security: { category: "rights", reason: "Missing consent" },
        },
      },
    ],
  });
  const starts = sessions(flow);
  const traceStart = opsTrace(flow).length;
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld),
  );
  const stopped = savedState(readWorld(flow.ghDir));
  assert.equal(stopped.security, null);
  assert.deepEqual(stopped.merged, savedState(interruptedWorld).merged);
  assert.equal(stopped.stage, "stopped");
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.equal(merges(flow).length, 0);
  assert.deepEqual(
    replayFacts(flow, traceStart).targetUpdates,
    expectedReplay(interruptedWorld).targetUpdates,
  );
  const ops = opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
  assert.equal(ops.includes("finish"), false);
});

test("closed recovery retains merged truth and runs no actual-result suite, writer or completion, even with failing checks configured", () => {
  const config = fs.readFileSync(flow.config, "utf8");
  const settings = z
    .looseObject({ commands: z.looseObject({ test: z.string() }) })
    .parse(JSON.parse(config));
  fs.writeFileSync(
    flow.config,
    JSON.stringify({
      ...settings,
      commands: { ...settings.commands, test: "false" },
    }),
  );
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  try {
    assert.equal(runStage(flow, "merge").end, "stop");
    assert.equal(sessions(flow), starts);
    const facts = replayFacts(flow, traceStart);
    assert.deepEqual(facts.forbidden, []);
    assert.equal(facts.merges, 0);
    assert.deepEqual(
      facts.targetUpdates,
      expectedReplay(interruptedWorld).targetUpdates,
    );
    assert.deepEqual(
      facts.codeMerged,
      expectedReplay(interruptedWorld).codeMerged,
    );
    assert.deepEqual(facts.verified, []);
    const state = savedState(readWorld(flow.ghDir));
    assert.deepEqual(state.merged, savedState(interruptedWorld).merged);
    assert.equal(state.security, null);
    const ops = opsTrace(flow)
      .slice(traceStart)
      .map(({ request }) => request.op);
    assert.equal(ops.includes("finish"), false);
  } finally {
    fs.writeFileSync(flow.config, config);
  }
});
