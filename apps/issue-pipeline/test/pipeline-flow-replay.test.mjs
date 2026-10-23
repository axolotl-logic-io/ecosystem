// @ts-check
// The real roles, claims and finish ops replay an interrupted
// own explicit-target branch merge. Git and the built programs are real; GitHub and pi are
// local fakes. The caller assigns one issue, branch and stage. After Land
// only read-only confirmation runs; missing premerge proof stops (#185).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { nativeTargetUpdates } from "./fake-pipeline-flow-gh-native.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  issueStateIn,
  landedEvidence,
  landOrder,
  opsSince,
  PREMERGE_ONLY,
  postLandFacts,
  readOnlyAfterLand,
} from "./pipeline-flow-post-land-test-kit.mjs";
import {
  completeSetupStage,
  REPLAY_SETUP,
  restoreClearedReceipt,
} from "./pipeline-flow-recovery-test-kit.mjs";
import {
  expectedReplay,
  historicalMerge,
  merges,
  prepareReplayFlow,
  replaceState,
  replayFacts,
  restoreReplay,
  securityBundle,
  securityEvidence,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run-test-kit.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import { ISSUE, setUpFlow } from "./pipeline-flow-test-kit.mjs";

/** @type {import("./pipeline-flow-test-kit.mjs").Flow} */
let flow;
/** @type {import("./fake-pipeline-flow-gh-world.mjs").World} */
let interruptedWorld;
/** @type {import("./fake-pipeline-flow-gh-world.mjs").World} the own FF merge done with premerge clearance, before finish */
let clearedWorld;
/** @type {string} the review-module gitlink the Developer's draft adds */
let gitlink;
let replayReady = false;
/** @type {{ integration?: import("../src/state.ts").Integration }} */
const setup = {};

before(() => {
  flow = setUpFlow();
  gitlink = prepareReplayFlow(flow);
});
beforeEach(() => {
  if (!replayReady) {
    return;
  }
  restoreReplay(flow, interruptedWorld);
});
after(() => stopJobs(flow));

/** @param {{ stage: string, action: string }} step */
function runSetupStep(step) {
  return completeSetupStage(flow, step, setup);
}

for (const step of REPLAY_SETUP) {
  test(`replay setup ${step.stage} reaches ${step.end} within its own deadline`, () => {
    assert.equal(runSetupStep(step), step.end);
  });
}

// Checks and Security (its bundle has the gitlink and docs change) clear
// exactly the landed candidate before Land, then only confirmation (#185).
test("replay setup merge reaches deferred within its own deadline", () => {
  assert.equal(runStage(flow, "merge").end, "deferred");
  const current = savedState(readWorld(flow.ghDir));
  assert.equal(current.stage, "done");
  assert.equal(current.security.phase, "candidate");
  assert.deepEqual(current.security.revision, current.merged);
  assert.deepEqual(current.merged, current.mergeAttempt.authorized);
  assert.equal(current.verifiedSha, current.merged.code);
  assert.deepEqual(current.security.target, current.hardenedTarget);
  assert.deepEqual(landOrder(flow, current.merged.code), PREMERGE_ONLY);
  const { launch } = securityEvidence(flow, current.merged.code);
  assert.equal(launch?.commitScope, false);
  const { diff, bundle, files } = securityBundle(flow, current.merged.code);
  assert.ok(diff.includes("+Hello, world!"));
  assert.ok(diff.includes(`+Subproject commit ${gitlink}`));
  assert.ok(diff.includes("+Greetings say Hello, world!"));
  assert.ok(bundle.startsWith(diff));
  assert.ok(files.includes("Greetings say Hello, world!"));
  clearedWorld = readWorld(flow.ghDir);
  assert.ok(setup.integration !== undefined);
  historicalMerge(flow, setup.integration);
  fs.unlinkSync(path.join(flow.root, "interrupt-finish"));
  const world = readWorld(flow.ghDir);
  const historical = savedState(world);
  assert.equal(historical.stage, "merge");
  assert.equal(historical.security, null);
  assert.deepEqual(historical.merged, current.merged);
  assert.notEqual(historical.hardened.code, historical.merged.code);
  interruptedWorld = world;
  replayReady = true;
});

test("the interrupted own merge saved its provenance before Security despite default-branch auto-close", () => {
  assert.equal(replayReady, true);
  const state = savedState(interruptedWorld);
  assert.equal(state.stage, "merge");
  assert.equal(state.security, null);
  assert.deepEqual(state.codeMerged, { pr: state.pr, sha: state.merged.code });
  assert.equal(state.mergeAttempt.result, state.merged.code);
  assert.deepEqual(state.mergeAttempt.authorized, state.integration.revision);
  assert.equal(state.verifiedSha, state.merged.code);
  assert.notEqual(state.hardened.code, state.integration.revision.code);
  assert.equal(state.merged.code, state.integration.revision.code);
  assert.equal(
    interruptedWorld.prs[0]?.mergedHead,
    state.integration.revision.code,
  );
  assert.equal(interruptedWorld.prs[0]?.mergeOid, state.merged.code);
  assert.equal(issueStateIn(interruptedWorld), "closed");
  assert.equal(merges(flow).length, 0);
  assert.deepEqual(
    nativeTargetUpdates(readWorld(flow.ghDir)),
    expectedReplay(interruptedWorld).targetUpdates,
  );
});

test("claim-populated replay without premerge Security stops read-only: no suite, Security bundle or model, writer, merge or completion", () => {
  assert.equal(replayReady, true);
  assert.equal(savedState(interruptedWorld).stage, "merge");
  const callsStart = ghCalls(flow.ghDir).length;
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld),
  );
  const stopped = savedState(readWorld(flow.ghDir));
  assert.equal(stopped.security, null);
  assert.deepEqual(stopped.merged, savedState(interruptedWorld).merged);
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
  const ops = opsSince(flow, traceStart);
  assert.equal(ops.includes("finish"), false);
  assert.equal(ops.includes("prepare-review"), false);
  assert.equal(issueStateIn(readWorld(flow.ghDir)), "open");
});

test("stale security cannot authorize replay completion or closure, and no assessment runs after Land", () => {
  assert.equal(replayReady, true);
  const state = savedState(interruptedWorld);
  const stale = state.hardened;
  assert.notDeepEqual(stale, state.merged);
  replaceState(flow, {
    ...state,
    security: {
      revision: stale,
      commentId: state.gherkin.commentId,
      finding: null,
    },
  });
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld),
  );
  assert.deepEqual(savedState(readWorld(flow.ghDir)).security.revision, stale);
  assert.equal(opsSince(flow, traceStart).includes("finish"), false);
  assert.equal(issueStateIn(readWorld(flow.ghDir)), "open");
});

test("a saved rejection on the actual merged result re-stops without a model, writer, second merge or completion", () => {
  assert.equal(replayReady, true);
  assert.equal(savedState(interruptedWorld).stage, "merge");
  const state = savedState(interruptedWorld);
  assert.equal(state.stage, "merge");
  assert.equal(state.security, null);
  assert.deepEqual(state.merged, state.mergeAttempt.authorized);
  replaceState(flow, {
    ...state,
    security: {
      revision: state.merged,
      commentId: state.gherkin.commentId,
      finding: { category: "abuse-risk", reason: "Missing authorization" },
    },
  });
  assert.deepEqual(
    savedState(readWorld(flow.ghDir)).security.revision,
    state.merged,
  );
  const starts = sessions(flow);
  const traceStart = opsTrace(flow).length;
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld, false),
  );
  const world = readWorld(flow.ghDir);
  const issue = world.issues.find(({ number }) => number === ISSUE);
  assert.equal(issue?.state, "open");
  assert.ok(issue !== undefined);
  assert.ok(issue.labels.includes("agent:stopped-abuse-risk"));
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.equal(merges(flow).length, 0);
  assert.deepEqual(
    nativeTargetUpdates(readWorld(flow.ghDir)),
    expectedReplay(interruptedWorld).targetUpdates,
  );
});

test("an own FF merge without exact premerge check proof stops before completion, with no suite, model or writer", () => {
  const cleared = savedState(clearedWorld);
  restoreClearedReceipt(flow, clearedWorld, { verifiedSha: null });
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(
    postLandFacts(replayFacts(flow, traceStart)),
    readOnlyAfterLand([{ confirmed: false }]),
  );
  const stopped = savedState(readWorld(flow.ghDir));
  assert.deepEqual(landedEvidence(stopped), landedEvidence(cleared));
  assert.equal(stopped.verifiedSha, null);
  const ops = opsSince(flow, traceStart);
  assert.equal(ops.includes("finish"), false);
  assert.equal(ops.includes("prepare-review"), false);
});

test("an interrupted own FF merge with exact premerge proof completes read-only, survives a completion interruption and replays without a suite or model", () => {
  const cleared = savedState(clearedWorld);
  const expected = readOnlyAfterLand([
    { confirmed: true, headSha: cleared.merged.code },
  ]);
  restoreClearedReceipt(flow, clearedWorld);
  const interrupt = path.join(flow.root, "interrupt-finish");
  fs.writeFileSync(interrupt, "interrupt before the finish op");
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "deferred");
  assert.deepEqual(postLandFacts(replayFacts(flow, traceStart)), expected);
  const completed = savedState(readWorld(flow.ghDir));
  assert.equal(completed.stage, "done");
  assert.deepEqual(landedEvidence(completed), landedEvidence(cleared));
  fs.unlinkSync(interrupt);
  const retryStart = opsTrace(flow).length;
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(postLandFacts(replayFacts(flow, retryStart)), expected);
  const world = readWorld(flow.ghDir);
  const done = savedState(world);
  assert.equal(done.stage, "done");
  assert.deepEqual(landedEvidence(done), landedEvidence(cleared));
  assert.equal("wiki" in done.security.revision, false);
  assert.equal(issueStateIn(world), "closed");
  assert.deepEqual(
    nativeTargetUpdates(world),
    expectedReplay(interruptedWorld).targetUpdates,
  );
});
