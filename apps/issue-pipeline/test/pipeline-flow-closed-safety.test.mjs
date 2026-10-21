// @ts-check
// Closed own-merge recovery must preserve merged truth on failed safety gates.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";
import { readWorld, writeWorld } from "./pipeline-flow-gh-world.mjs";
import { scriptPi, setUpFlow } from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  createReplayFlow,
  expectedReplay,
  merges,
  replayFacts,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { savedState } from "./pipeline-flow-script.mjs";

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
/** @type {import("./pipeline-flow-gh-world.mjs").World} */
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

test("a fresh exact Security rejection stops closed recovery and cannot be rerolled", () => {
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
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld),
  );
  const rejected = savedState(readWorld(flow.ghDir));
  assert.deepEqual(rejected.security.revision, rejected.merged);
  assert.equal(rejected.security.finding.category, "rights");
  assert.equal(rejected.stage, "stopped");
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts + 1);
  assert.equal(merges(flow).length, 1);
  const ops = opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
  assert.equal(ops.includes("finish"), false);
});

test("closed recovery retains merged truth when actual-result verification fails without a writer or completion", () => {
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
    assert.equal(facts.merges, 1);
    assert.deepEqual(
      facts.codeMerged,
      expectedReplay(interruptedWorld).codeMerged,
    );
    assert.deepEqual(facts.verified, [
      { pass: false, headSha: expectedReplay(interruptedWorld).base },
    ]);
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
