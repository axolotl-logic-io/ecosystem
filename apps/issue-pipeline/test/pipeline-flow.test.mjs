// @ts-check
// One issue through the built orchestrator, jobs, ops and tool extensions.
// Local git origins, pipeline-flow-gh and pipeline-flow-pi fake the services;
// the stages themselves run unchanged, not through direct role calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { fieldOf, flagsOf } from "./fake-pipeline-flow-gh-api.mjs";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { jobLog, stopJobs, tick } from "./pipeline-flow-run-test-kit.mjs";
import {
  authorTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  refIn,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";
import { PROMPT_PAGES } from "./prompt-test-kit.mjs";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    When they arrive\n    Then they see a polite greeting";
const SECURITY_TAG_LENGTH = 12;
const GHERKIN_IN_PROMPT = /Then they see a polite greeting/u;
const MERGED_PAGE = /Greetings say Hello, world!/u;
const REVIEWED_CODE = /\+Hello, world!/u;
const REVIEWED_DOCS = /\+Greetings say Hello, world!/u;
const MERGE_ENDPOINT = /^repos\/[^/]+\/[^/]+\/merges$/u;

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */

/** @type {Flow} */
let flow;
/** @type {string} the origin's base head before the flow */
let start;
/** @type {string[]} every stage the flow started, until it went idle */
let stages;

/** @returns {any[]} each pi start, in order */
function piStarts() {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

/** @returns {string} */
function baseHead() {
  return String(refIn(flow.origin, `refs/heads/${BASE}`));
}

before(() => {
  flow = setUpFlow();
  start = baseHead();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true)],
    implementor: [implementorTurn("hello, world", "Greet with hello, world")],
    reviewer: [
      implementorTurn("Hello, world", "Hardening capitalizes the greeting"),
      implementorTurn("Hello, world!", "Integration fixes the failed CI check"),
      securityTurn(),
    ],
  });
  stages = [];
});
after(() => stopJobs(flow));

// Each bounded stage, not the aggregate multi-job lifecycle, gets the test
// deadline. The before hook used to charge every stage to the first test.
/** @param {string} stage @returns {Promise<{ started: string[], log: string }>} */
async function completeStage(stage) {
  const result = await tick(flow);
  stages.push(...result.started);
  if (stage === "review") {
    const hardened = savedState(readWorld(flow.ghDir));
    withWorld(flow.ghDir, (world) => {
      world.failedHead = hardened.hardened.code;
    });
  }
  return { started: result.started, log: jobLog(flow) };
}
for (const stage of ["author", "implement", "review", "merge", "merge"]) {
  test(`legacy tick completes the ${stage} stage`, async () => {
    const result = await completeStage(stage);
    assert.deepEqual(result.started, [stage], result.log);
  });
}

test("completed legacy flow goes idle without another job", async () => {
  const result = await tick(flow);
  assert.deepEqual(result.started, [], jobLog(flow));
});

test("legacy ticks run development, hardening, bounded integration and security without a Developer fix round", () => {
  assert.deepEqual(
    stages,
    ["author", "implement", "review", "merge", "merge"],
    jobLog(flow),
  );
});

test("each phase gets its configured model and exact write authority without a GitHub token", () => {
  const starts = piStarts();
  assert.deepEqual(
    starts.map((each) => each.role),
    ["author", "implementor", "reviewer", "reviewer", "reviewer"],
  );
  const powers = starts.map((each) => ({
    ghToken: each.ghToken,
    commitScope: each.commitScope,
    commits: each.extensions.includes("pipeline-commit.mjs"),
  }));
  const expected = [false, true, true, true, false].map((writes) => ({
    ghToken: null,
    commitScope: writes,
    commits: writes,
  }));
  assert.deepEqual(powers, expected);
});

test("hardening, integration and final security get pinned pages and truthful revision provenance", () => {
  const starts = piStarts();
  const pages = PROMPT_PAGES.map(({ page }) => page);
  for (const [at, page] of pages.entries()) {
    const launched = starts[at];
    assert.ok(launched !== undefined);
    const flag = launched.argv.indexOf("--append-system-prompt");
    const text = fs.readFileSync(path.join(flow.prompts, page), "utf8");
    assert.equal(launched.argv[flag + 1], text);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const usage = readWorld(flow.ghDir)
      .comments.map(({ body }) => body)
      .join("\n");
    assert.ok(usage.includes(sha256), `missing usage provenance for ${page}`);
  }
  const [, , harden, integrate, security] = piLog(flow.piDir).filter(
    (entry) => "prompt" in entry,
  );
  assert.match(String(harden?.prompt), GHERKIN_IN_PROMPT);
  assert.match(String(integrate?.prompt), GHERKIN_IN_PROMPT);
  const state = savedState(readWorld(flow.ghDir));
  assert.ok(String(security?.prompt).includes(state.merged.code));
  assert.equal("wiki" in state.merged, false);
  assert.deepEqual(state.integration.reviewed, state.hardened);
  assert.notEqual(state.integration.revision.code, state.hardened.code);
  assert.deepEqual(state.security.revision, state.merged);
  assert.equal(state.security.finding, null);
  assert.ok(state.security.commentId > 0);
  const tag = `review-security-${state.merged.code.slice(0, SECURITY_TAG_LENGTH)}`;
  const diff = path.join(
    flow.root,
    "runs",
    SLUG,
    `issue-${ISSUE}`,
    tag,
    "diff.patch",
  );
  const reviewed = fs.readFileSync(diff, "utf8");
  assert.match(reviewed, REVIEWED_CODE);
  assert.match(reviewed, REVIEWED_DOCS);
  const [, , , , securityStart] = starts;
  assert.ok(securityStart !== undefined);
  const tools =
    securityStart.argv[securityStart.argv.indexOf("--tools") + 1].split(",");
  for (const tool of ["write", "edit", "bash", "pipeline_commit"]) {
    assert.equal(tools.includes(tool), false);
  }
});

test("GitHub ends with the issue closed as merged, the PR merged at the approved head, and the state done with its merge receipt", () => {
  const world = readWorld(flow.ghDir);
  const state = savedState(world);
  assert.equal(world.prs.length, 1);
  const [pr] = world.prs;
  assert.ok(pr !== undefined);
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
      verdict: null,
      pr: "MERGED",
      mergedHead: state.integration.revision.code,
      merged: { ...state.integration.revision, code: pr.mergeOid },
      issue: ["closed", "completed", ["agent:merged"]],
      reviews: 2,
      unsupported: [],
    },
  );
});

test("the one branch POST names only integration and the checked full source head", () => {
  const { integration } = savedState(readWorld(flow.ghDir));
  const merges = ghCalls(flow.ghDir)
    .filter(([command]) => command === "api")
    .map((args) => flagsOf(args.slice(1)))
    .filter(({ endpoint }) => MERGE_ENDPOINT.test(endpoint));
  assert.equal(merges.length, 1);
  const [request] = merges;
  assert.ok(request !== undefined);
  assert.deepEqual(
    {
      endpoint: request.endpoint,
      method: request.method,
      base: fieldOf(request.fields, "base"),
      head: fieldOf(request.fields, "head"),
    },
    {
      endpoint: "repos/o/r/merges",
      method: "POST",
      base: "integration",
      head: integration.revision.code,
    },
  );
});

test("git ends with ordered parents covering the whole approved change, its docs included, on the base", () => {
  const base = baseHead();
  const { merged, integration } = savedState(readWorld(flow.ghDir));
  assert.equal(base, merged.code);
  assert.equal(bareGit(flow.origin, ["rev-parse", `${base}^1`]), start);
  assert.equal(
    bareGit(flow.origin, ["rev-parse", `${base}^2`]),
    integration.revision.code,
  );
  const greeting = bareGit(flow.origin, ["show", `${base}:greet.txt`]);
  assert.equal(greeting, "Hello, world!");
  const page = bareGit(flow.origin, ["show", `${base}:docs/Home.md`]);
  assert.match(page, MERGED_PAGE);
});

// Runs last: it reopens the issue as if the completion's close was lost.
test("a completion replayed on a reopened done issue closes it again with no model, merging nothing new", async () => {
  const done = baseHead();
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
      base: baseHead(),
      prs: world.prs.length,
      issue: issue?.state,
      stage: savedState(world).stage,
      merged: savedState(world).merged,
      unsupported: world.unsupported,
    },
    {
      started: ["merge"],
      sessions,
      base: done,
      prs: 1,
      issue: "closed",
      stage: "done",
      merged: receipt,
      unsupported: [],
    },
    jobLog(flow),
  );
});
