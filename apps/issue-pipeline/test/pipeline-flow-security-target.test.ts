// An outside actor advances the target to an ancestor of unchanged H during
// the real read-only Security session. A finding must survive save/stop/reclaim.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { ghCalls } from "./fake-pipeline-flow-gh.ts";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import { opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import {
  merges,
  prepareReplayFlow,
  sessions,
} from "./pipeline-flow-replay-test-kit.ts";
import {
  runStage,
  runThroughTasks,
  stopJobs,
} from "./pipeline-flow-run-test-kit.ts";
import { savedState } from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import {
  BASE,
  bareGit,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.ts";

let flow: Flow;
let target = "";
let moved = "";
let traceStart = 0;
let callsStart = 0;
let sessionStart = 0;
const FINDING = {
  category: "rights",
  reason: "The candidate exposes private chats",
};
after(() => stopJobs(flow));

test("a returned finding survives target-only movement at the actual session/save boundary", () => {
  flow = setUpFlow();
  prepareReplayFlow(flow);
  assert.equal(runStage(flow, "author").end, "next");
  assert.equal(runStage(flow, "implement").end, "next");
  const implemented = savedState(readWorld(flow.ghDir)).headSha;
  assert.ok(implemented !== null);
  moved = implemented;
  assert.equal(runStage(flow, "review").end, "next");
  const hardened = savedState(readWorld(flow.ghDir));
  assert.ok(hardened.hardenedTarget !== null && hardened.hardened !== null);
  assert.ok(hardened.hardened.code !== null);
  target = hardened.hardenedTarget.sha;
  assert.notEqual(moved, target);
  assert.notEqual(moved, hardened.hardened.code);
  bareGit(flow.origin, ["merge-base", "--is-ancestor", target, moved]);
  bareGit(flow.origin, [
    "merge-base",
    "--is-ancestor",
    moved,
    hardened.hardened.code,
  ]);
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, {
    reviewer: [
      {
        targetAdvance: {
          origin: flow.origin,
          branch: BASE,
          before: target,
          after: moved,
        },
        output: { summary: "Private chats leak", security: FINDING },
      },
    ],
  });
  traceStart = opsTrace(flow).length;
  callsStart = ghCalls(flow.ghDir).length;
  sessionStart = sessions(flow);
  assert.equal(runThroughTasks(flow, "merge").at(-1)?.end, "stop");
  const rejected = savedState(readWorld(flow.ghDir));
  assert.equal(rejected.stopCode, "rights");
  assert.ok(rejected.security !== null);
  assert.deepEqual(rejected.security.revision, hardened.hardened);
  assert.equal(rejected.security.phase, "candidate");
  assert.deepEqual(rejected.security.target, hardened.hardenedTarget);
  assert.deepEqual(rejected.security.finding, FINDING);
  assert.equal(rejected.merged, null);
  assert.equal(refIn(flow.origin, BASE), moved);
  assert.equal(sessions(flow), sessionStart + 1);
});

test("reclaim cannot reroll the unchanged rejected subject or approve and merge it", () => {
  const prior = savedState(readWorld(flow.ghDir));
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "stop");
  const rejected = savedState(readWorld(flow.ghDir));
  assert.equal(rejected.stopCode, "rights");
  assert.deepEqual(rejected.security, prior.security);
  assert.deepEqual(rejected.hardened, prior.hardened);
  assert.equal(rejected.security?.target?.sha, target);
  assert.equal(refIn(flow.origin, BASE), moved);
  assert.equal(sessions(flow), starts);
  const launches = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .slice(sessionStart);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.commitScope, false);
  assert.equal(launches[0]?.extensions?.includes("pipeline-commit.mjs"), false);
  assert.equal(launches[0]?.ghToken, null);
  const trace = opsTrace(flow).slice(traceStart);
  assert.ok(
    !trace.some(({ request }) =>
      ["merge", "push", "sync-base", "exit-push", "finish"].includes(
        request.op,
      ),
    ),
  );
  assert.ok(
    !ghCalls(flow.ghDir)
      .slice(callsStart)
      .some(([command, action]) => command === "pr" && action === "review"),
  );
  assert.equal(merges(flow).length, 0);
  assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
});
