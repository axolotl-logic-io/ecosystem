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
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
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
import {
  runStage,
  runThroughTasks,
  stopJobs,
} from "./pipeline-flow-run-test-kit.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import { ISSUE, refIn, setUpFlow } from "./pipeline-flow-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { policyRevision } = await import("../src/project-policy.ts");
// A checking-policy setting the flow's own commands never reach.
const MOVED_TIMEOUT_MINUTES = 21;
const POSTMERGE = ["prepare-review", "verify", "push", "exit-push", "merge"];
const POSTMERGE_REFUSED = /postmerge hardening is not allowed/u;

/** @type {import("./pipeline-flow-test-kit.mjs").Flow} */
let flow;
/** @type {import("./fake-pipeline-flow-gh-world.mjs").World} */
let interruptedWorld;
/** @type {import("./fake-pipeline-flow-gh-world.mjs").World} the own FF merge done with premerge clearance, before finish */
let clearedWorld;
/** @type {string} the review-module gitlink the Developer's draft adds */
let gitlink;
let replayReady = false;
/** @type {{ integration?: import("../src/state.ts").Integration, reviewed?: import("../src/state.ts").Revision }} */
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
  assert.equal(runThroughTasks(flow, "merge").at(-1).end, "deferred");
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

test("an own FF merge whose saved attempt has no signed intent is refused by confirmation, with no suite, model or completion", () => {
  const cleared = savedState(clearedWorld);
  const { operation: _intent, ...legacy } = cleared.mergeAttempt;
  restoreClearedReceipt(flow, clearedWorld, { mergeAttempt: legacy });
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(
    postLandFacts(replayFacts(flow, traceStart)),
    readOnlyAfterLand([{ confirmed: false }]),
  );
  const stopped = savedState(readWorld(flow.ghDir));
  assert.deepEqual(stopped.merged, cleared.merged);
  assert.deepEqual(stopped.security, cleared.security);
  const ops = opsSince(flow, traceStart);
  assert.equal(ops.includes("finish"), false);
  assert.equal(ops.includes("prepare-review"), false);
  assert.equal(issueStateIn(readWorld(flow.ghDir)), "open");
});

// confirm-merged also refuses an intent for another PR, result or receipt;
// before it can, the claim refuses an attempt GitHub doesn't confirm.
test("an own FF merge whose saved attempt names another PR starts nothing after Land", () => {
  const cleared = savedState(clearedWorld);
  restoreClearedReceipt(flow, clearedWorld, {
    mergeAttempt: { ...cleared.mergeAttempt, pr: cleared.pr + 1 },
  });
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "unclaimed");
  assert.equal(sessions(flow), starts);
  const ops = opsSince(flow, traceStart);
  for (const name of ["confirm-merged", "verify", "merge", "finish"]) {
    assert.equal(ops.includes(name), false, name);
  }
  assert.notEqual(savedState(readWorld(flow.ghDir)).stage, "done");
});

/**
 * Runs `check` with the operator's checking policy moved after Land.
 * @param {() => void} check
 */
function withMovedPolicy(check) {
  const original = fs.readFileSync(flow.config, "utf8");
  fs.writeFileSync(
    flow.config,
    JSON.stringify({
      ...JSON.parse(original),
      commandTimeoutMinutes: MOVED_TIMEOUT_MINUTES,
    }),
  );
  try {
    check();
  } finally {
    fs.writeFileSync(flow.config, original);
  }
}

test("a policy move after Land stops read-only: no result Security session, suite or completion, and merged truth stays", () => {
  const cleared = savedState(clearedWorld);
  restoreClearedReceipt(flow, clearedWorld);
  withMovedPolicy(() => {
    const traceStart = opsTrace(flow).length;
    const starts = sessions(flow);
    assert.equal(runStage(flow, "merge").end, "stop");
    assert.equal(sessions(flow), starts);
    const stopped = savedState(readWorld(flow.ghDir));
    assert.deepEqual(landedEvidence(stopped), landedEvidence(cleared));
    assert.equal(stopped.resultSecurity ?? null, null);
    const ops = opsSince(flow, traceStart);
    for (const name of ["verify", "prepare-review", "merge", "finish"]) {
      assert.equal(ops.includes(name), false, name);
    }
    assert.equal(issueStateIn(readWorld(flow.ghDir)), "open");
  });
});

test("a result Security observation saved before #185 for the moved policy still completes read-only", () => {
  const cleared = savedState(clearedWorld);
  withMovedPolicy(() => {
    const { policy } = policyRevision(loadConfig(flow.config));
    assert.notEqual(policy, cleared.merged.policy);
    const resultSecurity = {
      revision: { ...cleared.merged, policy },
      target: cleared.security.target,
      commentId: cleared.security.commentId,
      finding: null,
    };
    restoreClearedReceipt(flow, clearedWorld, { resultSecurity });
    const traceStart = opsTrace(flow).length;
    const starts = sessions(flow);
    assert.equal(runStage(flow, "merge").end, "next");
    assert.equal(sessions(flow), starts);
    assert.deepEqual(
      postLandFacts(replayFacts(flow, traceStart)),
      readOnlyAfterLand([{ confirmed: true, headSha: cleared.merged.code }]),
    );
    const done = savedState(readWorld(flow.ghDir));
    assert.equal(done.stage, "done");
    assert.deepEqual(done.resultSecurity, resultSecurity);
    assert.equal(issueStateIn(readWorld(flow.ghDir)), "closed");
  });
});

test("hardening after Land is refused before preparation, a suite, a session or a push, keeping merged provenance", () => {
  const state = savedState(interruptedWorld);
  assert.notEqual(state.codeMerged, null);
  replaceState(flow, { ...state, stage: "review" });
  withWorld(flow.ghDir, (world) => {
    const issue = world.issues.find(({ number }) => number === ISSUE);
    assert.ok(issue !== undefined);
    issue.state = "open";
  });
  const head = refIn(flow.origin, `refs/heads/agent/issue-${ISSUE}`);
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "review").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.deepEqual(
    opsSince(flow, traceStart).filter((op) => POSTMERGE.includes(op)),
    [],
  );
  assert.equal(refIn(flow.origin, `refs/heads/agent/issue-${ISSUE}`), head);
  const stopped = savedState(readWorld(flow.ghDir));
  assert.deepEqual(stopped.codeMerged, state.codeMerged);
  assert.deepEqual(stopped.hardened, state.hardened);
  assert.equal(stopped.verifiedSha, state.verifiedSha);
  assert.ok(
    readWorld(flow.ghDir).comments.some(
      ({ issue, body }) => issue === ISSUE && POSTMERGE_REFUSED.test(body),
    ),
  );
});

// #183's task results, #184's Sync and #185's Integration and exact Land are
// inactive: across every stage this file ran, from setup through Land,
// completion and recovery, no installed role asked for or recorded a result,
// ran Sync or Integration, or bound a Land, and GitHub holds no record.
test("the installed path records the task chain through the landing account, binds its Land and never runs a hidden Sync (#186)", () => {
  const trace = opsTrace(flow);
  const ran = trace.map(({ request }) => request.op);
  // The merge stage's own synchronization retired: no job asks for it.
  assert.deepEqual(
    ran.filter((op) => op === "sync-base" || op === "finish-sync"),
    [],
  );
  // Every Land names its exact binding and a run.
  const lands = trace.filter(({ request }) => request.op === "merge");
  assert.ok(lands.length > 0, "the trace covers Land");
  for (const { request: sent } of lands) {
    /** @type {any} */
    const request = sent;
    assert.equal(request.binding?.task, "Land");
    assert.equal(request.binding.revision.code, request.expectedSha);
    assert.equal(request.binding.target.commit, request.expectedBase);
    assert.ok(request.landRun?.id);
  }
  const records = clearedWorld.comments.filter(({ body }) =>
    body.startsWith("<!-- agent-pipeline:task-result"),
  );
  assert.deepEqual(
    [...new Set(records.map(({ login }) => login))],
    [clearedWorld.account],
  );
  const kinds = records.map(({ body }) => {
    const record = JSON.parse(body.split("\n").slice(1, -1).join("\n"));
    return [record.binding.task, record.kind, record.verdict]
      .filter(Boolean)
      .join(" ");
  });
  // Implementation of the requirements, Hardening of the first head, its
  // Integration, then the head Hardening fixed after CI failed, its
  // Integration, Security and Land.
  assert.deepEqual(kinds, [
    "Implementation attempt",
    "Implementation result passed",
    "Hardening attempt",
    "Hardening result passed",
    "Integration attempt",
    "Integration result passed",
    "Hardening attempt",
    "Hardening result passed",
    "Integration attempt",
    "Integration result passed",
    "Security attempt",
    "Security result passed",
    "Land attempt",
    "Land result passed",
  ]);
});
