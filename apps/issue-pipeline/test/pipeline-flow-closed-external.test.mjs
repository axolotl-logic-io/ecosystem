// @ts-check
// A closed incomplete Merge without response evidence must obtain independent
// postmerge hardening, never inherit the premerge authorization as an own receipt.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { branchMerge } from "./pipeline-flow-gh-merge.mjs";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  merges,
  prepareReplayFlow,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import {
  hardeningTurn,
  savedState,
  securityTurn,
} from "./pipeline-flow-script.mjs";

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
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

test("confirmed closed recovery without a response needs fresh postmerge hardening", () => {
  const prior = savedState(readWorld(flow.ghDir));
  assert.equal(prior.mergeAttempt, null);
  assert.equal(prior.merged, null);
  assert.equal(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.state,
    "closed",
  );
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), starts);
  const recovered = savedState(readWorld(flow.ghDir));
  assert.equal(recovered.stage, "review");
  assert.deepEqual(recovered.codeMerged, {
    pr: prior.pr,
    sha: refIn(flow.origin, BASE),
  });
  assert.equal(recovered.mergeAttempt, null);
  assert.equal(recovered.merged, null);
  assert.equal(recovered.hardened, null);
  assert.equal(recovered.security, null);
  assert.equal(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.state,
    "open",
  );
});

test("independent actual-result hardening and exact Security precede completion", () => {
  const merged = refIn(flow.origin, BASE);
  assert.equal(runStage(flow, "review").end, "next");
  const hardened = savedState(readWorld(flow.ghDir));
  assert.equal(hardened.hardened.code, merged);
  assert.equal(hardened.merged, null);
  assert.equal(hardened.security, null);
  fs.writeFileSync(path.join(flow.root, "interrupt-finish"), "pause finish");
  assert.equal(runStage(flow, "merge").end, "deferred");
  const cleared = savedState(readWorld(flow.ghDir));
  assert.deepEqual(cleared.security.revision, hardened.hardened);
  assert.equal(cleared.security.finding, null);
  assert.deepEqual(cleared.merged, hardened.hardened);
});

test("external recovery completes without a pipeline merge POST or code push", () => {
  fs.unlinkSync(path.join(flow.root, "interrupt-finish"));
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), starts);
  const world = readWorld(flow.ghDir);
  const done = savedState(world);
  assert.equal(done.stage, "done");
  assert.equal(done.mergeAttempt, null);
  assert.deepEqual(done.merged, done.security.revision);
  assert.equal(done.merged.wiki, null);
  assert.equal(
    world.issues.find(({ number }) => number === ISSUE)?.state,
    "closed",
  );
  const trace = opsTrace(flow).slice(traceStart);
  assert.ok(
    trace
      .filter(({ request }) => request.op === "push")
      .every(
        ({ request }) => "wikiOnly" in request && request.wikiOnly === true,
      ),
  );
  assert.equal(
    trace.some(({ request }) =>
      ["merge", "exit-push", "sync-base"].includes(request.op),
    ),
    false,
  );
  assert.equal(merges(flow).length, 0);
  assert.deepEqual(world.unsupported, []);
});
