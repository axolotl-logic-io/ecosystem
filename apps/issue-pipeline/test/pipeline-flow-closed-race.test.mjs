// @ts-check
// A real authorized FF lands and auto-closes its issue, but incompatible PR
// binding withholds the own receipt. Installed-caller recovery stays read-only
// and confirms the premerge proof without a suite after Land (#185).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { nativeTargetUpdates } from "./fake-pipeline-flow-gh-native.mjs";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  confirmationsSince,
  opsSince,
} from "./pipeline-flow-post-land-test-kit.mjs";
import { refusedRecovery } from "./pipeline-flow-recovery-test-kit.mjs";
import {
  createReplayFlow,
  expectedTargetUpdates,
  merges,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import {
  runCallerStage,
  runStage,
  stopJobs,
} from "./pipeline-flow-run-test-kit.mjs";
import { savedState, securityTurn } from "./pipeline-flow-script-test-kit.mjs";
import "./isolated-root-test-kit.mjs";
import {
  BASE,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";

const SHA_LENGTH = 40;
const CLAIM_AUTHORITY = z.object({
  state: z.object({ hardened: z.unknown(), integration: z.unknown() }),
});

/** @type {import("./pipeline-flow-test-kit.mjs").Flow} */
let flow;
/** @type {import("./fake-pipeline-flow-gh-world.mjs").World} */
let interruptedWorld;
let traceStart = 0;
before(() => {
  flow = setUpFlow();
  ({ interruptedWorld } = createReplayFlow(flow, true));
});
after(() => stopJobs(flow));

test("the accepted merge auto-closes the issue before delayed confirmation stops Merge without an own receipt", () => {
  const stopped = savedState(readWorld(flow.ghDir));
  assert.equal(stopped.stage, "stopped");
  assert.equal(stopped.stoppedStage, "merge");
  assert.equal(stopped.stopCode, "merge-refused");
  assert.equal(stopped.merged, null);
  assert.deepEqual(stopped.codeMerged, {
    pr: stopped.pr,
    sha: stopped.hardened.code,
  });
  assert.equal(readWorld(flow.ghDir).withholdMergeBinding, true);
  assert.deepEqual(stopped.security.revision, stopped.hardened);
  assert.equal(stopped.security.finding, null);
  const issue = readWorld(flow.ghDir).issues.find(
    ({ number }) => number === ISSUE,
  );
  assert.equal(issue?.state, "closed");
  assert.equal(merges(flow).length, 0);
  assert.deepEqual(
    nativeTargetUpdates(readWorld(flow.ghDir)),
    expectedTargetUpdates(readWorld(flow.ghDir)),
  );
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  assert.equal(merged, stopped.hardened.code);
  assert.deepEqual(stopped.hardenedTarget, {
    repo: "o/r",
    branch: BASE,
    sha: stopped.mergeAttempt.operation.base,
  });
  assert.equal(stopped.mergeAttempt.result, merged);
  assert.deepEqual(stopped.mergeAttempt.authorized, stopped.hardened);
});

/** Prepare explicit recovery without running it or asserting results. */
function prepareClosedRecovery() {
  withWorld(flow.ghDir, (world) => {
    world.withholdMergeBinding = false;
  });
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [securityTurn()] });
  // Inspect durable exact Security before the finish op can complete it.
  fs.writeFileSync(path.join(flow.root, "interrupt-finish"), "pause finish");
  traceStart = opsTrace(flow).length;
  const callsStart = ghCalls(flow.ghDir).length;
  const starts = sessions(flow);
  return { callsStart, starts };
}

test("the installed caller reaches closed recovery and reconciles the saved response with original authorization", async () => {
  const stopped = savedState(readWorld(flow.ghDir));
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  const { callsStart, starts } = prepareClosedRecovery();
  assert.equal(stopped.stage, "stopped");
  assert.equal(stopped.merged, null);
  assert.deepEqual(stopped.codeMerged, { pr: stopped.pr, sha: merged });
  // Exact authenticated intent and matching evidence, not equal heads alone.
  assert.equal((await runCallerStage(flow, "merge")).end, "deferred");
  const recovered = savedState(readWorld(flow.ghDir));
  assert.equal(recovered.stage, "done");
  assert.deepEqual(recovered.codeMerged, { pr: stopped.pr, sha: merged });
  assert.deepEqual(recovered.merged, {
    ...stopped.hardened,
    code: merged,
  });
  assert.equal(recovered.mergeAttempt.result, stopped.mergeAttempt.result);
  assert.ok(recovered.mergeAttempt.reads > stopped.mergeAttempt.reads);
  const claimed = CLAIM_AUTHORITY.parse(
    opsTrace(flow)
      .slice(traceStart)
      .find(({ request }) => request.op === "claim")?.reply,
  );
  assert.deepEqual(claimed.state.hardened, stopped.hardened);
  assert.deepEqual(claimed.state.integration, stopped.integration);
  assert.deepEqual(recovered.hardened, stopped.hardened);
  assert.deepEqual(recovered.integration, stopped.integration);
  assert.deepEqual(recovered.hardenedTarget, stopped.hardenedTarget);
  assert.deepEqual(
    { ...recovered.mergeAttempt, reads: stopped.mergeAttempt.reads },
    stopped.mergeAttempt,
  );
  assert.deepEqual(recovered.security, stopped.security);
  assert.equal(sessions(flow), starts);
  assert.equal(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.state,
    "open",
  );
  assert.ok(
    ghCalls(flow.ghDir)
      .slice(callsStart)
      .some(
        ([command, action, target]) =>
          command === "issue" &&
          action === "reopen" &&
          target === String(ISSUE),
      ),
  );
});

test("read-only confirmation of the premerge check proof precedes reuse of exact Security and completion", () => {
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  const cleared = savedState(readWorld(flow.ghDir));
  assert.equal(cleared.stage, "done");
  assert.ok(cleared.security !== null);
  assert.deepEqual(cleared.security.revision, cleared.hardened);
  assert.equal(cleared.security.finding, null);
  assert.ok(cleared.security.commentId > 0);
  assert.equal(cleared.verifiedSha, merged);
  assert.deepEqual(confirmationsSince(flow, traceStart), [
    { confirmed: true, headSha: merged },
  ]);
  const ops = opsSince(flow, traceStart);
  assert.equal(ops.includes("verify"), false);
  assert.equal(ops.includes("prepare-review"), false);
  assert.equal(merged, cleared.security.revision.code);
});

test("exact clearance permits completion with merged labels and completed closure", () => {
  const cleared = savedState(readWorld(flow.ghDir));
  assert.equal(cleared.stage, "done");
  assert.deepEqual(cleared.security.revision, cleared.merged);
  assert.equal(cleared.security.finding, null);
  fs.unlinkSync(path.join(flow.root, "interrupt-finish"));
  const clearedStarts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), clearedStarts);
  const world = readWorld(flow.ghDir);
  const done = savedState(world);
  assert.equal(done.stage, "done");
  assert.deepEqual(done.security, cleared.security);
  assert.equal("wiki" in done.security.revision, false);
  const completed = world.issues.find(({ number }) => number === ISSUE);
  assert.equal(completed?.state, "closed");
  assert.equal(completed?.stateReason, "completed");
  assert.ok(completed?.labels.includes("agent:merged"));
  assert.ok(
    world.issues
      .find(({ number }) => number === done.pr)
      ?.labels.includes("agent:merged"),
  );
});

test("recovery confirmed the actual result read-only without a suite, another code push or merge POST", () => {
  const world = readWorld(flow.ghDir);
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  assert.equal(savedState(world).stage, "done");
  const trace = opsTrace(flow).slice(traceStart);
  assert.equal(opsSince(flow, traceStart).includes("verify"), false);
  const confirmed = confirmationsSince(flow, traceStart);
  assert.ok(confirmed.length > 0);
  assert.ok(
    confirmed.every(
      ({ confirmed: ok, headSha }) => ok === true && headSha === merged,
    ),
  );
  assert.equal(
    trace.some(({ request }) => request.op === "push"),
    false,
  );
  assert.equal(
    trace.some(({ request }) =>
      ["merge", "exit-push", "sync-base"].includes(request.op),
    ),
    false,
  );
  assert.equal(merges(flow).length, 0);
  assert.deepEqual(
    nativeTargetUpdates(readWorld(flow.ghDir)),
    expectedTargetUpdates(readWorld(flow.ghDir)),
  );
  assert.equal(refIn(flow.origin, `refs/heads/${BASE}`), merged);
  assert.deepEqual(world.unsupported, []);
});

/** @param {Record<string, unknown> | null} extra */
function refusedClosedRecovery(extra) {
  return refusedRecovery(flow, interruptedWorld, extra);
}

for (const [name, extra] of Object.entries({
  "no saved state": null,
  "ineligible Review state": { stage: "review", stoppedStage: null },
  "stale retained head": { headSha: "b".repeat(SHA_LENGTH) },
  "another assigned branch": { branch: "another-assignment" },
})) {
  test(`the installed caller leaves closed Merge with ${name} untouched`, async () => {
    const seen = await refusedClosedRecovery(extra);
    assert.equal(seen.result.end, "unclaimed");
    assert.ok(seen.result.claimError);
    assert.deepEqual(seen.after, seen.before);
    assert.deepEqual(seen.ops, ["claim"]);
    assert.deepEqual(seen.writes, []);
  });
}
