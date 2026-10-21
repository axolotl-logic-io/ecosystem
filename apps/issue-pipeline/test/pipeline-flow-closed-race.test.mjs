// @ts-check
// A real authorized branch POST lands and auto-closes its issue, but delayed
// PR confirmation refuses the merge receipt. The installed caller must reach
// canonical recovery without granting authority or repeating the code mutation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import { isStateBody } from "../src/comment-marks.ts";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import {
  readWorld,
  withWorld,
  writeWorld,
} from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  createReplayFlow,
  merges,
  replaceState,
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
const MUTATION_ARGS = new Set([
  "POST",
  "PATCH",
  "DELETE",
  "reopen",
  "close",
  "edit",
  "create",
]);
const { loadConfig } = await import("../src/config.ts");
const { configPolicyDigest } = await import("../src/project-policy.ts");

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
  assert.equal(stopped.codeMerged, null);
  assert.equal(stopped.security, null);
  const issue = readWorld(flow.ghDir).issues.find(
    ({ number }) => number === ISSUE,
  );
  assert.equal(issue?.state, "closed");
  assert.equal(merges(flow).length, 1);
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  assert.notEqual(merged, stopped.integration.revision.code);
  assert.equal(stopped.mergeAttempt.result, merged);
  assert.deepEqual(
    stopped.mergeAttempt.authorized,
    stopped.integration.revision,
  );
});

test("the installed caller reaches closed recovery and reconciles the saved response with original authorization", async () => {
  const stopped = savedState(readWorld(flow.ghDir));
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  withWorld(flow.ghDir, (world) => {
    world.delayMergeConfirmation = false;
  });
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [securityTurn()] });
  // Inspect durable exact Security before the finish op can complete it.
  fs.writeFileSync(path.join(flow.root, "interrupt-finish"), "pause finish");
  traceStart = opsTrace(flow).length;
  const callsStart = ghCalls(flow.ghDir).length;
  const starts = sessions(flow);
  // The saved response plus fresh matching evidence may establish an own
  // receipt. PR truth alone would not be sufficient to do so.
  assert.equal((await runCallerStage(flow, "merge")).end, "deferred");
  const recovered = savedState(readWorld(flow.ghDir));
  assert.equal(recovered.stage, "done");
  assert.deepEqual(recovered.codeMerged, { pr: stopped.pr, sha: merged });
  assert.deepEqual(recovered.merged, {
    ...stopped.integration.revision,
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
  assert.equal(sessions(flow), starts + 1);
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

test("actual-result checks precede read-only exact Security and completion", () => {
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  const cleared = savedState(readWorld(flow.ghDir));
  assert.deepEqual(cleared.security.revision, {
    code: merged,
    inputs: cleared.integration.revision.inputs,
    policy: configPolicyDigest(loadConfig(flow.config)),
  });
  const trace = opsTrace(flow).slice(traceStart);
  const securityClaim = trace.findIndex(
    ({ request }) => request.op === "prepare-review",
  );
  const verify = trace.findIndex(({ request }) => request.op === "verify");
  assert.ok(verify >= 0);
  assert.ok(securityClaim > verify);
  assert.equal(cleared.security.finding, null);
  assert.ok(cleared.security.commentId > 0);
  const security = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .at(-1);
  assert.equal(security?.commitScope, false);
});

test("exact clearance permits completion with merged labels and completed closure", () => {
  const cleared = savedState(readWorld(flow.ghDir));
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

test("recovery verified the actual result without another code push or merge POST", () => {
  const world = readWorld(flow.ghDir);
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  const trace = opsTrace(flow).slice(traceStart);
  const verified = trace.filter(({ request }) => request.op === "verify");
  assert.ok(verified.length > 0);
  assert.ok(
    verified.every(
      ({ reply: { pass, headSha } }) => pass === true && headSha === merged,
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
  assert.equal(merges(flow).length, 1);
  assert.equal(refIn(flow.origin, `refs/heads/${BASE}`), merged);
  assert.deepEqual(world.unsupported, []);
});

for (const [name, extra] of Object.entries({
  "no saved state": null,
  "ineligible Review state": { stage: "review", stoppedStage: null },
  "stale retained head": { headSha: "b".repeat(SHA_LENGTH) },
  "another assigned branch": { branch: "another-assignment" },
})) {
  test(`the installed caller leaves closed Merge with ${name} untouched`, async () => {
    const seen = await refusedRecovery(extra);
    assert.equal(seen.result.end, "unclaimed");
    assert.ok(seen.result.claimError);
    assert.deepEqual(seen.after, seen.before);
    assert.deepEqual(seen.ops, ["claim"]);
    assert.deepEqual(seen.writes, []);
  });
}

/** @typedef {{world: import("./fake-pipeline-flow-gh-world.mjs").World, head: string | null, branch: string | null, sessions: number}} RecoverySnapshot */
/**
 * @param {Record<string, unknown> | null} extra
 * @returns {Promise<{result: Awaited<ReturnType<typeof runCallerStage>>, before: RecoverySnapshot, after: RecoverySnapshot, ops: string[], writes: string[][]}>}
 */
async function refusedRecovery(extra) {
  writeWorld(flow.ghDir, structuredClone(interruptedWorld));
  withWorld(flow.ghDir, (world) => {
    world.delayMergeConfirmation = false;
    if (extra === null) {
      world.comments = world.comments.filter(({ body }) => !isStateBody(body));
    }
  });
  if (extra !== null) {
    replaceState(flow, { ...savedState(interruptedWorld), ...extra });
  }
  const snapshot = {
    world: readWorld(flow.ghDir),
    head: refIn(flow.origin, `refs/heads/${BASE}`),
    branch: refIn(flow.origin, `refs/heads/agent/issue-${ISSUE}`),
    sessions: sessions(flow),
  };
  const beforeCalls = ghCalls(flow.ghDir).length;
  const beforeTrace = opsTrace(flow).length;
  const result = await runCallerStage(flow, "merge");
  return {
    result,
    before: snapshot,
    after: {
      world: readWorld(flow.ghDir),
      head: refIn(flow.origin, `refs/heads/${BASE}`),
      branch: refIn(flow.origin, `refs/heads/agent/issue-${ISSUE}`),
      sessions: sessions(flow),
    },
    ops: opsTrace(flow)
      .slice(beforeTrace)
      .map(({ request }) => request.op),
    writes: ghCalls(flow.ghDir)
      .slice(beforeCalls)
      .filter((args) => args.some((arg) => MUTATION_ARGS.has(arg))),
  };
}
