// @ts-check
// The real roles, claims, publication and finish ops replay an interrupted
// own explicit-target branch merge. Git and the built programs are real; GitHub and pi are
// local fakes. The caller assigns one issue, branch and stage.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { readWorld, withWorld, writeWorld } from "./pipeline-flow-gh-world.mjs";
import {
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
  WIKI_BRANCH,
} from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  expectedReplay,
  merges,
  prepareReplayFlow,
  replaceState,
  replayFacts,
  securityEvidence,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { savedState, securityTurn } from "./pipeline-flow-script.mjs";

const INTERRUPTED = { output: {}, rejectPrompt: "read ECONNRESET" };
const SECURITY_PHASE = "security.md";
const SECURITY_TAG_LENGTH = 12;

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
/** @type {import("./pipeline-flow-gh-world.mjs").World} */
let interruptedWorld;
/** @type {string | null} */
let originalWiki;
let replayReady = false;

/** @param {string} mergedSha @returns {{ diff: string, bundle: string, files: string }} */
function securityBundle(mergedSha) {
  const tag = `review-security-${mergedSha.slice(0, SECURITY_TAG_LENGTH)}`;
  const dir = path.join(flow.root, "runs", "o__r", `issue-${ISSUE}`, tag);
  const diff = fs.readFileSync(path.join(dir, "diff.patch"), "utf8");
  const bundle = fs.readFileSync(path.join(dir, "bundle.md"), "utf8");
  return { diff, bundle, files: bundle.slice(diff.length) };
}

before(() => {
  flow = setUpFlow();
  originalWiki = prepareReplayFlow(flow);
});
beforeEach(() => {
  if (!replayReady) {
    return;
  }
  writeWorld(flow.ghDir, structuredClone(interruptedWorld));
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [INTERRUPTED] });
});
after(() => stopJobs(flow));

/** @param {string} stage @param {string} action @returns {string} */
function completeSetupStage(stage, action) {
  const result = runStage(flow, stage);
  if (action === "fail-ci") {
    withWorld(flow.ghDir, (world) => {
      world.failedHead = savedState(world).hardened.code;
    });
  }
  if (action === "snapshot") {
    interruptedWorld = readWorld(flow.ghDir);
    replayReady = true;
  }
  return result.end;
}

for (const step of [
  { stage: "author", end: "next", action: "none" },
  { stage: "implement", end: "next", action: "none" },
  { stage: "review", end: "next", action: "fail-ci" },
  { stage: "merge", end: "wait", action: "none" },
  { stage: "merge", end: "deferred", action: "snapshot" },
]) {
  test(`replay setup ${step.stage} reaches ${step.end} within its own deadline`, () => {
    assert.equal(completeSetupStage(step.stage, step.action), step.end);
  });
}

test("the interrupted own merge saved its provenance before Security despite default-branch auto-close", () => {
  const state = savedState(interruptedWorld);
  assert.equal(state.stage, "merge");
  assert.equal(state.security, null);
  assert.deepEqual(state.codeMerged, { pr: state.pr, sha: state.merged.code });
  assert.equal(state.mergeAttempt.result, state.merged.code);
  assert.deepEqual(state.mergeAttempt.authorized, state.integration.revision);
  assert.equal(state.verifiedSha, state.merged.code);
  assert.notEqual(state.hardened.code, state.integration.revision.code);
  assert.notEqual(state.merged.code, state.integration.revision.code);
  assert.equal(
    interruptedWorld.prs[0]?.mergedHead,
    state.integration.revision.code,
  );
  assert.equal(interruptedWorld.prs[0]?.mergeOid, state.merged.code);
  assert.equal(
    interruptedWorld.issues.find(({ number }) => number === ISSUE)?.state,
    "closed",
  );
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
  assert.equal(merges(flow).length, 1);
});

test("claim-populated replay cannot publish or close without security when the fresh assessment is interrupted", () => {
  const callsStart = ghCalls(flow.ghDir).length;
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "deferred");
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld),
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
  const ops = opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
  assert.equal(ops.includes("publish"), false);
  assert.equal(ops.includes("finish-wiki"), false);
  assert.equal(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.state,
    "open",
  );
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
});

test("retained publish-only recovery bundles an added gitlink and pending wiki before Security", () => {
  const traceStart = opsTrace(flow).length;
  assert.equal(runStage(flow, "merge").end, "deferred");
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld),
  );
  const state = savedState(readWorld(flow.ghDir));
  const { diff, bundle, files } = securityBundle(state.merged.code);
  assert.ok(diff.includes(`+Subproject commit ${originalWiki}`));
  assert.ok(diff.includes("+Greetings say Hello, world!"));
  assert.ok(bundle.startsWith(diff));
  assert.ok(
    files.includes(
      `\n## review-module\n\nGitlink: path only. Old: absent; new: commit \`${originalWiki}\`.\n`,
    ),
  );
  assert.ok(!files.includes("Greetings say"));
  assert.ok(!files.includes("The wiki."));
});

test("stale security cannot authorize replay publication or closure; a new assessment is required", () => {
  const state = savedState(interruptedWorld);
  replaceState(flow, {
    ...state,
    security: {
      revision: state.integration.revision,
      commentId: state.gherkin.commentId,
      finding: null,
    },
  });
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "deferred");
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(
    replayFacts(flow, traceStart),
    expectedReplay(interruptedWorld),
  );
  const ops = opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
  assert.equal(ops.includes("publish"), false);
  assert.equal(ops.includes("finish-wiki"), false);
  assert.equal(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.state,
    "open",
  );
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
});

test("a saved rejection on the actual merged result re-stops without a model, writer, second merge or publication", () => {
  const state = savedState(interruptedWorld);
  replaceState(flow, {
    ...state,
    security: {
      revision: state.merged,
      commentId: state.gherkin.commentId,
      finding: { category: "abuse-risk", reason: "Missing authorization" },
    },
  });
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
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
  assert.equal(runStage(flow, "merge").end, "stop");
  assert.equal(sessions(flow), starts);
  assert.equal(merges(flow).length, 1);
});

test("missing security is reviewed read-only at the actual first-parent merge diff, then exact approval survives a publication interruption and is reused", () => {
  const expected = expectedReplay(interruptedWorld);
  scriptPi(flow, { reviewer: [securityTurn()] });
  fs.writeFileSync(
    path.join(flow.root, "interrupt-publish"),
    "interrupt before publication",
  );
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "deferred");
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(replayFacts(flow, traceStart), expected);
  const approved = savedState(readWorld(flow.ghDir));
  assert.deepEqual(approved.security.revision, approved.merged);
  assert.equal(approved.security.finding, null);
  assert.ok(approved.security.commentId > 0);
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
  const { launch, diff } = securityEvidence(flow, approved.merged.code);
  assert.ok(launch !== undefined);
  assert.equal(launch.commitScope, false);
  assert.equal(launch.ghToken, null);
  assert.equal(launch.extensions.includes("pipeline-commit.mjs"), false);
  const securityPage = path.join(flow.prompts, SECURITY_PHASE);
  assert.ok(launch.argv.includes(fs.readFileSync(securityPage, "utf8")));
  assert.ok(diff.includes("+Hello, world!"));
  assert.ok(diff.includes("+Greetings say Hello, world!"));
  fs.unlinkSync(path.join(flow.root, "interrupt-publish"));
  const retryStart = opsTrace(flow).length;
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(replayFacts(flow, retryStart), expected);
  const world = readWorld(flow.ghDir);
  const done = savedState(world);
  assert.equal(done.stage, "done");
  assert.deepEqual(done.security, approved.security);
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    done.security.revision.wiki,
  );
  assert.equal(
    world.issues.find(({ number }) => number === ISSUE)?.state,
    "closed",
  );
});
