// @ts-check
// One issue taken through the whole pipeline as built: the built
// orchestrator's ticks start the built stage jobs, which run the built ops
// against real git origins and the fake GitHub, and the fake pi plays each
// model role's scripted turns through the real structured_output and
// pipeline_commit extensions. Nothing here calls a role function directly.
// Faked: GitHub (pipeline-flow-gh.mjs) and the model (pipeline-flow-pi.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { pageTextOf } from "./brain-test-kit.mjs";
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
  savedState,
  securityTurn,
} from "./pipeline-flow-script.mjs";

const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    When they arrive\n    Then they see a polite greeting";
const SECURITY_TAG_LENGTH = 12;
const GHERKIN_IN_PROMPT = /Then they see a polite greeting/u;
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
  return { ghToken: null, commitScope: writes, commits: writes };
}

before(async () => {
  flow = setUpFlow();
  start = heads();
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
  const authored = await tick(flow);
  const developed = await tick(flow);
  const reviewed = await tick(flow);
  stages = [...authored.started, ...developed.started, ...reviewed.started];
  const hardened = savedState(readWorld(flow.ghDir));
  withWorld(flow.ghDir, (world) => {
    world.failedHead = hardened.hardened.code;
  });
  stages.push(...(await stagesUntilIdle(flow)));
});
after(() => stopJobs(flow));

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
  assert.deepEqual(powers, [false, true, true, true, false].map(powersOf));
});

test("hardening, integration and final security get pinned pages and truthful revision provenance", () => {
  const starts = piStarts();
  const pages = ["Author", "Developer", "Hardening", "Integration", "Security"];
  for (const [at, name] of pages.entries()) {
    const launched = starts[at];
    assert.ok(launched !== undefined);
    const flag = launched.argv.indexOf("--append-system-prompt");
    const page = `Pipeline-Prompt-${name}.md`;
    assert.equal(launched.argv[flag + 1], pageTextOf(page));
    const sha256 = createHash("sha256").update(pageTextOf(page)).digest("hex");
    const usage = readWorld(flow.ghDir)
      .comments.map(({ body }) => body)
      .join("\n");
    assert.ok(usage.includes(sha256), `missing usage provenance for ${page}`);
  }
  const [, , harden, integrate, security] = prompts();
  assert.match(String(harden?.prompt), GHERKIN_IN_PROMPT);
  assert.match(String(integrate?.prompt), GHERKIN_IN_PROMPT);
  const state = savedState(readWorld(flow.ghDir));
  assert.ok(String(security?.prompt).includes(state.merged.code));
  assert.ok(String(security?.prompt).includes(state.merged.wiki));
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
  assert.match(reviewed, REVIEWED_WIKI);
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
  const merges = ghCalls(flow.ghDir).filter(
    ([command, endpoint]) =>
      command === "api" && endpoint === "repos/o/r/merges",
  );
  assert.deepEqual(merges, [
    [
      "api",
      "repos/o/r/merges",
      "--method",
      "POST",
      "--include",
      "-f",
      "base=integration",
      "-f",
      `head=${integration.revision.code}`,
    ],
  ]);
});

test("git ends with ordered parents covering the whole approved change on the base and the wiki fast-forwarded to the reviewed commit", () => {
  const { base, wiki } = heads();
  const { merged, integration } = savedState(readWorld(flow.ghDir));
  assert.equal(base, merged.code);
  assert.equal(bareGit(flow.origin, ["rev-parse", `${base}^1`]), start.base);
  assert.equal(
    bareGit(flow.origin, ["rev-parse", `${base}^2`]),
    integration.revision.code,
  );
  const greeting = bareGit(flow.origin, ["show", `${base}:greet.txt`]);
  assert.equal(greeting, "Hello, world!");
  assert.equal(wiki, integration.revision.wiki);
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
