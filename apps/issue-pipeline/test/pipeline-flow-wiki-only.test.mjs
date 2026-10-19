// @ts-check
// An issue whose change lives only in the wiki, taken through the whole
// pipeline as built (pipeline-flow-kit.mjs): the implementor commits to the
// wiki checkout alone, so its draft PR is closed and the issue names no PR;
// the Reviewer hardens it and then security-reviews the final wiki; merge
// publishes only the exactly cleared wiki and closes the issue as completed.
// Faked: GitHub (pipeline-flow-gh.mjs) and the model (pipeline-flow-pi.mjs).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
  WIKI_BRANCH,
} from "./pipeline-flow-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import { jobLog, stopJobs, tick } from "./pipeline-flow-run.mjs";
import {
  authorTurn,
  hardeningTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script.mjs";

const GHERKIN =
  "Feature: greeting docs\n  Scenario: documented\n    Given the wiki\n    Then it says how visitors are greeted";
const PAGE = "The wiki.\n\nVisitors are greeted with hello.\n";
const PUBLISHED_PAGE = /Visitors are greeted with hello\./u;
// The implementor's turn: the wiki page alone, committed in the wiki
// checkout by naming it.
const DOCS_ONLY_TURN = {
  files: { "docs/Home.md": PAGE },
  commits: [["-m", "Document the greeting", "docs/Home.md"]],
  output: { outcome: "done", summary: "Document the greeting" },
};

/** @typedef {import("./pipeline-flow-kit.mjs").Flow} Flow */

/** @type {Flow} */
let flow;
/** @type {{ base: string, wiki: string }} the origins' heads before the flow */
let start;
/** @type {string[]} every stage the flow started, until it went idle */
let stages;

/** @returns {number} how many sessions pi started */
function sessionCount() {
  return piLog(flow.piDir).filter((entry) => entry.start === true).length;
}

/** @returns {{ base: string, wiki: string }} */
function heads() {
  return {
    base: String(refIn(flow.origin, `refs/heads/${BASE}`)),
    wiki: String(refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`)),
  };
}

before(() => {
  flow = setUpFlow();
  start = heads();
  openFlowIssue(flow, "alice", "Document greetings", "Say how we greet.");
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true)],
    implementor: [DOCS_ONLY_TURN],
    reviewer: [hardeningTurn(), securityTurn()],
  });
  stages = [];
});
after(() => stopJobs(flow));

/** @returns {Promise<string[]>} */
async function completeWikiStage() {
  const { started } = await tick(flow);
  stages.push(...started);
  return started;
}

for (const stage of ["author", "implement", "review", "merge"]) {
  test(`wiki-only ${stage} completes within its own stage deadline`, async () => {
    assert.deepEqual(await completeWikiStage(), [stage]);
  });
}

test("a wiki-only change goes through author, implement, hardening and final security at merge, then starts nothing", async () => {
  assert.deepEqual((await tick(flow)).started, [], jobLog(flow));
  assert.deepEqual(
    stages,
    ["author", "implement", "review", "merge"],
    jobLog(flow),
  );
  const roles = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .map((entry) => entry.role);
  assert.deepEqual(roles, ["author", "implementor", "reviewer", "reviewer"]);
});

test("GitHub ends with the draft PR closed, unmerged and named by no state, hardening and security on the issue, and the issue closed as completed", () => {
  const world = readWorld(flow.ghDir);
  const state = savedState(world);
  const issue = world.issues.find(({ number }) => number === ISSUE);
  const reviews = world.comments.filter(({ body }) =>
    body.includes("role=reviewer"),
  );
  assert.deepEqual(
    {
      prs: world.prs.map((pr) => [pr.state, pr.isDraft, pr.mergeOid]),
      reviewsOn: reviews.map((comment) => comment.issue),
      issue: [issue?.state, issue?.stateReason, issue?.labels],
      unsupported: world.unsupported,
    },
    {
      prs: [["CLOSED", true, null]],
      reviewsOn: [ISSUE, ISSUE],
      issue: ["closed", "completed", ["agent:merged"]],
      unsupported: [],
    },
    jobLog(flow),
  );
  assert.deepEqual(
    {
      stage: state.stage,
      pr: state.pr,
      flows: state.flows,
      verdict: state.review.verdict,
      codeMerged: state.codeMerged,
      merged: state.merged,
    },
    {
      stage: "done",
      pr: null,
      flows: { code: false, wiki: true },
      verdict: null,
      codeMerged: null,
      merged: { ...state.hardened, code: null },
    },
  );
});

test("no code merges: GitHub gets no merge call and the base is where it started", () => {
  const merges = ghCalls(flow.ghDir).filter(
    ([command, sub]) => command === "pr" && sub === "merge",
  );
  assert.deepEqual(merges, []);
  assert.equal(heads().base, start.base);
});

test("the wiki fast-forwards to the hardened and security-cleared wiki commit, which holds the implementor's page", () => {
  const { wiki } = heads();
  const { hardened, security, merged } = savedState(readWorld(flow.ghDir));
  assert.equal(wiki, hardened.wiki);
  assert.equal(merged.wiki, wiki);
  assert.deepEqual(security.revision, merged);
  assert.equal(security.finding, null);
  assert.ok(security.commentId > 0);
  assert.notEqual(wiki, start.wiki);
  const ancestry = ["merge-base", "--is-ancestor", start.wiki, wiki];
  assert.doesNotThrow(() => bareGit(flow.wikiOrigin, ancestry));
  const page = bareGit(flow.wikiOrigin, ["show", `${wiki}:Home.md`]);
  assert.match(page, PUBLISHED_PAGE);
});

// Runs last: it reopens the issue as if the completion's close was lost.
test("a wiki-only completion replayed on a reopened done issue closes it again with no model, merging and publishing nothing new", async () => {
  const done = heads();
  const receipt = savedState(readWorld(flow.ghDir)).merged;
  withWorld(flow.ghDir, (reopened) => {
    const issue = reopened.issues.find(({ number }) => number === ISSUE);
    Object.assign(issue ?? {}, {
      state: "open",
      stateReason: null,
      labels: [],
    });
  });
  const sessions = sessionCount();
  const { started } = await tick(flow);
  const world = readWorld(flow.ghDir);
  const issue = world.issues.find(({ number }) => number === ISSUE);
  assert.deepEqual(
    {
      started,
      sessions: sessionCount(),
      heads: heads(),
      prs: world.prs.map((pr) => pr.state),
      issue: [issue?.state, issue?.stateReason],
      stage: savedState(world).stage,
      merged: savedState(world).merged,
      unsupported: world.unsupported,
    },
    {
      started: ["merge"],
      sessions,
      heads: done,
      prs: ["CLOSED"],
      issue: ["closed", "completed"],
      stage: "done",
      merged: receipt,
      unsupported: [],
    },
    jobLog(flow),
  );
});
