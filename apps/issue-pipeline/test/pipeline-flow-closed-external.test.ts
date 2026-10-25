// A closed incomplete Merge without response evidence never inherits the
// premerge authorization as an own receipt. Its checks and Security did not
// provably clear the merged result before the target moved, so it stops
// read-only with merged truth kept (#185): no postmerge hardening, suite,
// Security or completion.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { branchMerge } from "./fake-pipeline-flow-gh-merge.ts";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.ts";
import { opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import {
  merges,
  prepareReplayFlow,
  sessions,
} from "./pipeline-flow-replay-test-kit.ts";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.ts";
import {
  hardeningTurn,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import {
  BASE,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.ts";

let flow: Flow;
let traceStart = 0;
after(() => stopJobs(flow));

test("external merge setup retains genuine premerge authority and auto-closes the issue", () => {
  flow = setUpFlow();
  prepareReplayFlow(flow);
  for (const stage of ["author", "implement", "review"]) {
    assert.equal(runStage(flow, stage).end, "next");
  }
  // Another actor lands the same PR before the pipeline can send its POST.
  // Keep the genuine saved premerge state untouched: no attempt or response
  // was ever recorded. This also exercises historical v2 receipt absence.
  withWorld(flow.ghDir, (world) => {
    const state = savedState(world);
    assert.ok(state.hardened !== null);
    const response = branchMerge(world, [
      "repos/o/r/merges",
      "--method",
      "POST",
      "--include",
      "-f",
      `base=${BASE}`,
      "-f",
      `head=${state.hardened.code}`,
    ]);
    assert.equal(response.code, 0);
  });
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [hardeningTurn(), securityTurn()] });
  traceStart = opsTrace(flow).length;
});

test("confirmed closed recovery without a response stops read-only, never postmerge hardening", () => {
  const prior = savedState(readWorld(flow.ghDir));
  assert.equal(prior.mergeAttempt, null);
  assert.equal(prior.merged, null);
  assert.equal(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.state,
    "closed",
  );
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  const stopped = savedState(readWorld(flow.ghDir));
  assert.equal(stopped.stage, "stopped");
  assert.equal(stopped.stoppedStage, "merge");
  assert.deepEqual(stopped.codeMerged, {
    pr: prior.pr,
    sha: refIn(flow.origin, BASE),
  });
  assert.equal(stopped.mergeAttempt, null);
  assert.equal(stopped.merged, null);
  assert.deepEqual(stopped.hardened, prior.hardened);
  assert.equal(stopped.security, null);
});

test("external recovery runs no suite, Security bundle, merge POST, code push or completion", () => {
  const trace = opsTrace(flow).slice(traceStart);
  assert.equal(
    trace.some(({ request }) =>
      [
        "verify",
        "prepare-review",
        "merge",
        "push",
        "exit-push",
        "sync-base",
        "finish",
      ].includes(request.op),
    ),
    false,
  );
  assert.equal(merges(flow).length, 0);
  assert.notEqual(savedState(readWorld(flow.ghDir)).stage, "done");
  assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
});
