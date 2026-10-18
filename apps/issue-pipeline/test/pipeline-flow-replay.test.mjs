// @ts-check
// The real roles, claims, publication and finish ops replay an interrupted
// own explicit-target branch merge. Git and the built programs are real; GitHub and pi are
// local fakes. The caller assigns one issue, branch, stage and pinned brain.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { pageTextOf } from "./brain-test-kit.mjs";
import { readWorld, writeWorld } from "./pipeline-flow-gh-world.mjs";
import {
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
  WIKI_BRANCH,
} from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import {
  createReplayFlow,
  merges,
  replaceState,
  replayFacts,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { savedState, securityTurn } from "./pipeline-flow-script.mjs";

const INTERRUPTED = { output: {}, rejectPrompt: "read ECONNRESET" };
const SECURITY_PHASE = "Pipeline-Prompt-Security.md";
const SECURITY_TAG_LENGTH = 12;

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
/** @type {import("./pipeline-flow-gh-world.mjs").World} */
let interruptedWorld;
/** @type {string | null} */
let originalWiki;

/** @param {boolean} [checked] */
function expectedReplay(checked = true) {
  const state = savedState(interruptedWorld);
  const codeMerged = { pr: state.pr, sha: state.merged.code };
  /** @type {{ pass: boolean, headSha: string }[]} */
  let verified = [];
  /** @type {{ pass: boolean }[]} */
  let wikiChecked = [];
  if (checked) {
    verified = [{ pass: true, headSha: state.merged.code }];
    wikiChecked = [{ pass: true }];
  }
  return {
    claimCodeMerged: codeMerged,
    forbidden: [],
    merges: 1,
    verified,
    wikiChecked,
    base: state.merged.code,
    hardened: state.hardened,
    integration: state.integration,
    codeMerged,
    unsupported: [],
  };
}

before(() => {
  flow = setUpFlow();
  ({ interruptedWorld, originalWiki } = createReplayFlow(flow));
});
beforeEach(() => {
  writeWorld(flow.ghDir, structuredClone(interruptedWorld));
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [INTERRUPTED] });
});
after(() => stopJobs(flow));

test("the interrupted own merge saved original hardening/integration and its actual merge receipt, without publishing or closing", () => {
  const state = savedState(interruptedWorld);
  assert.equal(state.stage, "merge");
  assert.equal(state.security, null);
  assert.equal(state.codeMerged, null);
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
    "open",
  );
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
  assert.equal(merges(flow).length, 1);
});

test("claim-populated replay cannot publish or close without security when the fresh assessment is interrupted", () => {
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "deferred");
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(replayFacts(flow, traceStart), expectedReplay());
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
  assert.deepEqual(replayFacts(flow, traceStart), expectedReplay());
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
  assert.deepEqual(replayFacts(flow, traceStart), expectedReplay(false));
  const world = readWorld(flow.ghDir);
  const issue = world.issues.find(({ number }) => number === ISSUE);
  assert.equal(issue?.state, "open");
  assert.ok(issue !== undefined);
  assert.ok(issue.labels.includes("agent:stopped-abuse-risk"));
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
});

test("missing security is reviewed read-only at the actual first-parent merge diff, then exact approval survives a publication interruption and is reused", () => {
  scriptPi(flow, { reviewer: [securityTurn()] });
  fs.writeFileSync(
    path.join(flow.root, "interrupt-publish"),
    "interrupt before publication",
  );
  const traceStart = opsTrace(flow).length;
  const starts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "deferred");
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(replayFacts(flow, traceStart), expectedReplay());
  const approved = savedState(readWorld(flow.ghDir));
  assert.deepEqual(approved.security.revision, approved.merged);
  assert.equal(approved.security.finding, null);
  assert.ok(approved.security.commentId > 0);
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
  const launch = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .at(-1);
  assert.ok(launch !== undefined);
  assert.equal(launch.commitScope, false);
  assert.equal(launch.ghToken, null);
  assert.equal(launch.extensions.includes("pipeline-commit.mjs"), false);
  assert.ok(launch.argv.includes(pageTextOf(SECURITY_PHASE)));
  const tag = `review-security-${approved.merged.code.slice(0, SECURITY_TAG_LENGTH)}`;
  const diff = fs.readFileSync(
    path.join(flow.root, "runs", "o__r", `issue-${ISSUE}`, tag, "diff.patch"),
    "utf8",
  );
  assert.ok(diff.includes("+Hello, world!"));
  assert.ok(diff.includes("+Greetings say Hello, world!"));
  fs.unlinkSync(path.join(flow.root, "interrupt-publish"));
  const retryStart = opsTrace(flow).length;
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), starts + 1);
  assert.deepEqual(replayFacts(flow, retryStart), expectedReplay());
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
