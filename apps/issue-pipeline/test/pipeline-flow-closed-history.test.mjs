// @ts-check
// Canonical closed recovery of a saved pre-upgrade own receipt retains the
// original H0 -> H integration and real two-parent M without reopening writers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { readWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import {
  createReplayFlow,
  merges,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { savedState, securityTurn } from "./pipeline-flow-script.mjs";

const CLAIM = z.object({ state: z.looseObject({}) });
const VERIFIED = z.object({ pass: z.boolean(), headSha: z.string() });
const PREPARED = z.object({ headSha: z.string(), baseSha: z.string() });
/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
/** @type {import("../src/state.ts").IssueState} */
let original;
let result = "";
let parent = "";
let traceStart = 0;
let callsStart = 0;
let sessionStart = 0;
after(() => stopJobs(flow));

test("the closed historical fixture retains H0 != H, two-parent M and an already-saved own receipt", () => {
  flow = setUpFlow();
  createReplayFlow(flow);
  const world = readWorld(flow.ghDir);
  const snapshot = savedState(world);
  original = snapshot;
  const integrated = snapshot.integration.revision;
  result = snapshot.merged.code;
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
  assert.equal(parents.at(-1), integrated.code);
  assert.notEqual(result, integrated.code);
  parent = String(parents[0]);
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [securityTurn()] });
  traceStart = opsTrace(flow).length;
  callsStart = ghCalls(flow.ghDir).length;
  sessionStart = sessions(flow);
});

test("the winning closed claim preserves original authorization, attempt, result and own receipt", () => {
  assert.equal(runStage(flow, "merge").end, "next");
  const trace = opsTrace(flow).slice(traceStart);
  const claimed = CLAIM.parse(
    trace.find(({ request }) => request.op === "claim")?.reply,
  ).state;
  const recovered = savedState(readWorld(flow.ghDir));
  for (const [field, value] of Object.entries({
    hardened: original.hardened,
    integration: original.integration,
    mergeAttempt: original.mergeAttempt,
    merged: original.merged,
    codeMerged: original.codeMerged,
  })) {
    assert.deepEqual(claimed[field], value);
    assert.deepEqual(recovered[field], value);
  }
  assert.equal(recovered.stage, "done");
  assert.equal(recovered.security.revision.code, result);
  assert.equal(recovered.security.finding, null);
  assert.equal(recovered.security.phase, undefined);
  const verifies = trace
    .filter(({ request }) => request.op === "verify")
    .map(({ reply }) => VERIFIED.parse(reply));
  assert.ok(verifies.length > 0);
  assert.ok(
    verifies.every(({ pass, headSha }) => pass === true && headSha === result),
  );
  const prepared = PREPARED.parse(
    trace.find(({ request }) => request.op === "prepare-review")?.reply,
  );
  assert.equal(prepared.headSha, result);
  assert.equal(prepared.baseSha, parent);
});

test("historical recovery launches only read-only Security, with no writer, approval or second merge", () => {
  const trace = opsTrace(flow).slice(traceStart);
  assert.ok(
    !trace.some(({ request }) =>
      ["merge", "push", "sync-base", "exit-push", "ready-pr"].includes(
        request.op,
      ),
    ),
  );
  assert.equal(sessions(flow), sessionStart + 1);
  const launches = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .slice(sessionStart);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].commitScope, false);
  assert.equal(launches[0].extensions.includes("pipeline-commit.mjs"), false);
  assert.equal(launches[0].repoHead, result);
  assert.equal(launches[0].ghToken, null);
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
  assert.equal(merges(flow).length, 1);
  assert.equal(refIn(flow.origin, `refs/heads/${BASE}`), result);
  assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
});
