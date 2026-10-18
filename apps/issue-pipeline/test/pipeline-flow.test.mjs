// @ts-check
// One issue taken through the whole pipeline as built: the built
// orchestrator's ticks start the built stage jobs, which run the built ops
// against real git origins and the fake GitHub, and the fake pi plays each
// model role's scripted turns through the real structured_output and
// pipeline_commit extensions. Nothing here calls a role function directly.
// Faked: GitHub (pipeline-flow-gh.mjs) and the model (pipeline-flow-pi.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  refIn,
  SLUG,
  scriptPi,
  setUpFlow,
  WIKI_BRANCH,
} from "./pipeline-flow-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import {
  jobLog,
  stagesUntilIdle,
  stopJobs,
  tick,
} from "./pipeline-flow-run.mjs";
import {
  authorTurn,
  implementorTurn,
  openFlowIssue,
  reviewerTurn,
  savedState,
} from "./pipeline-flow-script.mjs";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    When they arrive\n    Then they see a polite greeting";
const FINDING_IN_PROMPT = /\[blocking\] \(greet\.txt:1\) Capitalize/u;
const ROUND_2 = /round 2/u;
const GHERKIN_IN_PROMPT = /Then they see a polite greeting/u;
const MERGE_JOB = /-merge$/u;
const PUBLISHED_PAGE = /Greetings say Hello, world!/u;
const REVIEWED_CODE = /\+Hello, world!/u;
const REVIEWED_WIKI = /\+Greetings say Hello, world!/u;

/** @typedef {import("./pipeline-flow-kit.mjs").Flow} Flow */

/** @type {Flow} */
let flow;
/** @type {{ base: string, wiki: string }} the origins' heads before the flow */
let start;
/** @type {string[]} every stage the flow started, until it went idle */
let stages;

/** @returns {any[]} each pi start, in order */
function piStarts() {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

/** @returns {any[]} each prompt pi was sent, in order */
function prompts() {
  return piLog(flow.piDir).filter((entry) => "prompt" in entry);
}

/** @returns {{ base: string, wiki: string }} */
function heads() {
  return {
    base: String(refIn(flow.origin, `refs/heads/${BASE}`)),
    wiki: String(refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`)),
  };
}

/**
 * What a model session may do, when it may commit or not.
 * @param {boolean} writes
 */
function powersOf(writes) {
  return { ghToken: null, commitScope: writes, commits: writes, merge: false };
}

before(async () => {
  flow = setUpFlow();
  start = heads();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true)],
    implementor: [
      implementorTurn("hello, world", "Greet with hello, world"),
      implementorTurn("Hello, world!", "Capitalize the greeting"),
    ],
    reviewer: [reviewerTurn("Capitalize the greeting"), reviewerTurn(null)],
  });
  stages = await stagesUntilIdle(flow);
});
after(() => stopJobs(flow));

test("the orchestrator's ticks take the issue through author, implement, a review asking for changes, implement, an approving review and merge, then start nothing", () => {
  assert.deepEqual(
    stages,
    ["author", "implement", "review", "implement", "review", "merge"],
    jobLog(flow),
  );
});

test("each model role runs with its own model and no GitHub token, only the implementor may commit, and the merge runs no model", () => {
  const starts = piStarts();
  assert.deepEqual(
    starts.map((each) => each.role),
    ["author", "implementor", "reviewer", "implementor", "reviewer"],
  );
  const powers = starts.map((each) => ({
    ghToken: each.ghToken,
    commitScope: each.commitScope,
    commits: each.extensions.includes("pipeline-commit.mjs"),
    merge: MERGE_JOB.test(each.cwd),
  }));
  assert.deepEqual(powers, [false, true, false, true, false].map(powersOf));
});

test("the second implementor round gets the blocking finding, and the second review the round and the Gherkin", () => {
  const [, , , fix, reReview] = prompts();
  assert.match(String(fix?.prompt), FINDING_IN_PROMPT);
  assert.match(String(reReview?.prompt), ROUND_2);
  assert.match(String(reReview?.prompt), GHERKIN_IN_PROMPT);
  const run = path.join(flow.root, "runs", SLUG, `issue-${ISSUE}`);
  const diff = path.join(run, "review-r2", "diff.patch");
  const reviewed = fs.readFileSync(diff, "utf8");
  assert.match(reviewed, REVIEWED_CODE);
  assert.match(reviewed, REVIEWED_WIKI);
});

test("GitHub ends with the issue closed as merged, the PR squash-merged at the approved head, and the state done with its merge receipt", () => {
  const world = readWorld(flow.ghDir);
  const state = savedState(world);
  assert.equal(world.prs.length, 1);
  const [pr] = world.prs;
  const issue = world.issues.find(({ number }) => number === ISSUE);
  const reviews = world.comments.filter(({ body }) =>
    body.includes("role=reviewer"),
  );
  assert.deepEqual(
    {
      stage: state.stage,
      verdict: state.review.verdict,
      pr: pr?.state,
      mergedHead: pr?.mergedHead,
      merged: state.merged,
      issue: [issue?.state, issue?.stateReason, issue?.labels],
      reviews: reviews.length,
      unsupported: world.unsupported,
    },
    {
      stage: "done",
      verdict: "approve",
      pr: "MERGED",
      mergedHead: state.review.revision.code,
      merged: { ...state.review.revision, code: pr?.mergeOid },
      issue: ["closed", "completed", ["agent:merged"]],
      reviews: 2,
      unsupported: [],
    },
  );
});

test("the one merge call squash-merges the PR only at the head the second review approved", () => {
  const { review, pr } = savedState(readWorld(flow.ghDir));
  const merges = ghCalls(flow.ghDir).filter(
    ([command, sub]) => command === "pr" && sub === "merge",
  );
  assert.equal(merges.length, 1);
  const [merge = []] = merges;
  const at = merge.indexOf("--match-head-commit");
  assert.deepEqual(
    { pr: merge[2], squash: merge.includes("--squash"), head: merge[at + 1] },
    { pr: String(pr), squash: true, head: review.revision.code },
  );
});

test("git ends with one squash commit of the approved change on the base and the wiki fast-forwarded to the reviewed commit", () => {
  const { base, wiki } = heads();
  const { merged, review } = savedState(readWorld(flow.ghDir));
  assert.equal(base, merged.code);
  assert.equal(bareGit(flow.origin, ["rev-parse", `${base}^`]), start.base);
  const greeting = bareGit(flow.origin, ["show", `${base}:greet.txt`]);
  assert.equal(greeting, "Hello, world!");
  assert.equal(wiki, review.revision.wiki);
  const ancestry = ["merge-base", "--is-ancestor", start.wiki, wiki];
  assert.doesNotThrow(() => bareGit(flow.wikiOrigin, ancestry));
  const page = bareGit(flow.wikiOrigin, ["show", `${wiki}:Home.md`]);
  assert.match(page, PUBLISHED_PAGE);
});

// Runs last: it reopens the issue as if the completion's close was lost.
test("a completion replayed on a reopened done issue closes it again with no model, merging and publishing nothing new", async () => {
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
  const sessions = piStarts().length;
  const { started } = await tick(flow);
  const world = readWorld(flow.ghDir);
  const issue = world.issues.find(({ number }) => number === ISSUE);
  assert.deepEqual(
    {
      started,
      sessions: piStarts().length,
      heads: heads(),
      prs: world.prs.length,
      issue: issue?.state,
      stage: savedState(world).stage,
      merged: savedState(world).merged,
      unsupported: world.unsupported,
    },
    {
      started: ["merge"],
      sessions,
      heads: done,
      prs: 1,
      issue: "closed",
      stage: "done",
      merged: receipt,
      unsupported: [],
    },
    jobLog(flow),
  );
});
