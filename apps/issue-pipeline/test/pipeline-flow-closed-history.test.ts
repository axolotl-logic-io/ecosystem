// Canonical closed recovery of a saved pre-upgrade own receipt retains the
// original H0 -> H integration and real two-parent M without reopening writers.
// A two-parent M has no exact fast-forward premerge proof, so recovery stops
// read-only (#185): no suite, Security session or completion after Land.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import type { IssueState } from "../src/state.ts";
import { ISSUE_STATE } from "../src/state.ts";
import { ghCalls } from "./fake-pipeline-flow-gh.ts";
import { nativeTargetUpdates } from "./fake-pipeline-flow-gh-native.ts";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import { createClosedHistoricalFlow } from "./pipeline-flow-closed-history-test-kit.ts";
import { opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import { merges, sessions } from "./pipeline-flow-replay-test-kit.ts";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.ts";
import { savedState, securityTurn } from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import {
  BASE,
  bareGit,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.ts";

const CLAIM = z.object({ state: z.looseObject({}) });
let flow: Flow;
let original: IssueState;
let fixture: ReturnType<typeof createClosedHistoricalFlow>;
let deliveryBaseline: {
  rest: string[][];
  native: ReturnType<typeof nativeTargetUpdates>;
};
let historicalReady = false;
let recoveryReady = false;
let resultReady = false;
let result = "";
let traceStart = 0;
let callsStart = 0;
let sessionStart = 0;
after(() => stopJobs(flow));

test("the closed historical fixture retains H0 != H, two-parent M and an already-saved own receipt", () => {
  flow = setUpFlow();
  fixture = createClosedHistoricalFlow(flow);
  assert.deepEqual(fixture.setup, ["next", "next", "next", "next", "next"]);
  assert.equal(fixture.response.code, 0);
  assert.equal(
    fixture.response.stdout,
    `HTTP/2.0 201 Created\r\n\r\n${JSON.stringify({ sha: fixture.historical.merged?.code })}`,
  );
  const world = readWorld(flow.ghDir);
  const snapshot = ISSUE_STATE.parse(savedState(world));
  original = snapshot;
  assert.ok(snapshot.integration);
  assert.ok(snapshot.hardened);
  assert.ok(snapshot.merged?.code);
  assert.ok(snapshot.mergeAttempt);
  const integrated = snapshot.integration.revision;
  result = snapshot.merged.code;
  assert.deepEqual(snapshot.hardened, fixture.reviewed.hardened);
  assert.deepEqual(snapshot.hardenedTarget, fixture.reviewed.hardenedTarget);
  assert.deepEqual(snapshot.integration, fixture.integrated.integration);
  const comments = world.comments.filter(({ body }) =>
    body.includes("<!-- agent-pipeline:state"),
  );
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.login, "bot");
  assert.equal(snapshot.stage, "merge");
  assert.notEqual(snapshot.hardened.code, integrated.code);
  assert.deepEqual(snapshot.integration.reviewed, snapshot.hardened);
  assert.deepEqual(snapshot.mergeAttempt.authorized, integrated);
  assert.equal(snapshot.mergeAttempt.result, result);
  assert.deepEqual(snapshot.codeMerged, { pr: snapshot.pr, sha: result });
  assert.equal(snapshot.security, null);
  assert.equal(
    world.issues.find(({ number }) => number === ISSUE)?.state,
    "closed",
  );
  const parents = bareGit(flow.origin, [
    "show",
    "-s",
    "--format=%P",
    result,
  ]).split(" ");
  assert.equal(parents.length, 2);
  assert.deepEqual(parents, [fixture.parent, integrated.code]);
  assert.notEqual(result, integrated.code);
  historicalReady = true;
});

test("the historical graph and original provenance agree before the isolated recovery baseline", () => {
  assert.equal(historicalReady, true);
  assert.ok(original.integration);
  assert.ok(original.mergeAttempt);
  const integrated = original.integration.revision;
  const world = readWorld(flow.ghDir);
  const pr = world.prs.find(({ number }) => number === original.pr);
  assert.ok(pr);
  assert.equal(pr.state, "MERGED");
  assert.equal(pr.mergeOid, result);
  assert.equal(pr.mergedHead, integrated.code);
  assert.equal(pr.head, original.branch);
  assert.equal(pr.base, BASE);
  assert.equal(refIn(flow.origin, `refs/heads/${pr.head}`), integrated.code);
  assert.equal(refIn(flow.origin, `refs/heads/${BASE}`), result);
  assert.equal(original.headSha, integrated.code);
  assert.equal(original.merged?.policy, integrated.policy);
  assert.deepEqual(original.mergeAttempt, {
    repo: world.repo,
    pr: original.pr,
    target: BASE,
    branch: original.branch,
    authorized: original.integration.revision,
    hardened: original.hardened,
    integration: original.integration,
    result: original.merged?.code,
    reads: 1,
  });
  assert.equal(original.mergeAttempt.operation, undefined);
  deliveryBaseline = { rest: merges(flow), native: nativeTargetUpdates(world) };
  assert.deepEqual(deliveryBaseline, { rest: [], native: [] });
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [securityTurn()] });
  traceStart = opsTrace(flow).length;
  callsStart = ghCalls(flow.ghDir).length;
  sessionStart = sessions(flow);
  recoveryReady = true;
});

test("the winning closed claim preserves original authorization, attempt, result and own receipt, then stops read-only", () => {
  assert.equal(recoveryReady, true);
  assert.equal(runStage(flow, "merge").end, "stop");
  const trace = opsTrace(flow).slice(traceStart);
  const claimed = CLAIM.parse(
    trace.find(({ request }) => request.op === "claim")?.reply,
  ).state;
  const recovered = savedState(readWorld(flow.ghDir));
  for (const field of [
    "hardened",
    "integration",
    "mergeAttempt",
    "merged",
    "codeMerged",
  ] as const) {
    const value = original[field];
    assert.deepEqual(claimed[field], value);
    assert.deepEqual(recovered[field], value);
  }
  assert.equal(recovered.stage, "stopped");
  assert.equal(recovered.security, null);
  const ops = trace.map(({ request }) => request.op);
  for (const op of ["verify", "prepare-review", "finish"]) {
    assert.equal(ops.includes(op), false, op);
  }
  resultReady = true;
});

test("historical recovery launches no session, writer, approval, suite or second merge", () => {
  assert.equal(resultReady, true);
  const trace = opsTrace(flow).slice(traceStart);
  assert.ok(
    !trace.some(({ request }) =>
      ["merge", "push", "sync-base", "exit-push", "ready-pr"].includes(
        request.op,
      ),
    ),
  );
  assert.equal(sessions(flow), sessionStart);
  const newCalls = ghCalls(flow.ghDir).slice(callsStart);
  assert.ok(
    newCalls.some(
      ([command, action, target]) =>
        command === "issue" && action === "reopen" && target === String(ISSUE),
    ),
  );
  assert.ok(
    !newCalls.some(
      ([command, action]) => command === "pr" && action === "review",
    ),
  );
  assert.deepEqual(merges(flow), deliveryBaseline.rest);
  assert.deepEqual(
    nativeTargetUpdates(readWorld(flow.ghDir)),
    deliveryBaseline.native,
  );
  assert.equal(refIn(flow.origin, `refs/heads/${BASE}`), result);
  assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
});
