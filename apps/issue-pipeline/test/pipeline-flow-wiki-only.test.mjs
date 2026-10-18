// @ts-check
// An issue whose change lives only in the wiki, taken through the whole
// pipeline as built (pipeline-flow-kit.mjs): the implementor commits to the
// wiki checkout alone, so its draft PR is closed and the issue names no PR;
// the reviewer approves on the issue; the merge job merges no code and
// publishes the reviewed wiki commit, then closes the issue as completed.
// Faked: GitHub (pipeline-flow-gh.mjs) and the model (pipeline-flow-pi.mjs).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { readWorld } from "./pipeline-flow-gh-world.mjs";
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
import { jobLog, stagesUntilIdle, stopJobs } from "./pipeline-flow-run.mjs";
import {
  authorTurn,
  openFlowIssue,
  reviewerTurn,
  savedState,
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

/** @returns {{ base: string, wiki: string }} */
function heads() {
  return {
    base: String(refIn(flow.origin, `refs/heads/${BASE}`)),
    wiki: String(refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`)),
  };
}

before(async () => {
  flow = setUpFlow();
  start = heads();
  openFlowIssue(flow, "alice", "Document greetings", "Say how we greet.");
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true)],
    implementor: [DOCS_ONLY_TURN],
    reviewer: [reviewerTurn(null)],
  });
  stages = await stagesUntilIdle(flow);
});
after(() => stopJobs(flow));

test("a wiki-only change goes through author, implement, an approving review and merge, then starts nothing", () => {
  assert.deepEqual(
    stages,
    ["author", "implement", "review", "merge"],
    jobLog(flow),
  );
  const roles = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .map((entry) => entry.role);
  assert.deepEqual(roles, ["author", "implementor", "reviewer"]);
});

test("GitHub ends with the draft PR closed, unmerged and named by no state, the approval on the issue, and the issue closed as completed", () => {
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
      reviewsOn: [ISSUE],
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
      verdict: "approve",
      codeMerged: null,
      merged: { ...state.review.revision, code: null },
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

test("the wiki fast-forwards to the reviewed wiki commit, which holds the implementor's page", () => {
  const { wiki } = heads();
  const { review, merged } = savedState(readWorld(flow.ghDir));
  assert.equal(wiki, review.revision.wiki);
  assert.equal(merged.wiki, wiki);
  assert.notEqual(wiki, start.wiki);
  const ancestry = ["merge-base", "--is-ancestor", start.wiki, wiki];
  assert.doesNotThrow(() => bareGit(flow.wikiOrigin, ancestry));
  const page = bareGit(flow.wikiOrigin, ["show", `${wiki}:Home.md`]);
  assert.match(page, PUBLISHED_PAGE);
});

