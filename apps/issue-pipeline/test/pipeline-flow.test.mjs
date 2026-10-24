// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { nativeTargetUpdates } from "./fake-pipeline-flow-gh-native.mjs";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import {
  baseHead,
  completeStage as driveStage,
  piStarts,
  scriptFlow,
} from "./pipeline-flow-provenance-test-kit.mjs";
import {
  jobLog,
  runTask,
  stopJobs,
  tick,
} from "./pipeline-flow-run-test-kit.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  SLUG,
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
const CI_RETURN = /Sent back from merge \(ci\)/u;

/** @type {import("./pipeline-flow-test-kit.mjs").Flow} */
let flow;
/** @type {string} the origin's base head before the flow */
let start;
/** @type {string[]} every stage the flow started, until it went idle */
const stages = [];
/** @type {import("../src/state.ts").IssueState[]} */
const checkpoints = [];

before(() => {
  flow = setUpFlow();
  start = baseHead(flow);
  scriptFlow(flow, GHERKIN);
  stages.length = 0;
});
after(() => stopJobs(flow));

/** @param {string} stage */
async function completeStage(stage) {
  const result = await driveStage(flow, stages, stage);
  checkpoints.push(result.state);
  return result;
}

/** @returns {any} the last job line the orchestrator's job log holds */
function lastJobLine() {
  return jobLog(flow)
    .split("\n")
    .filter((line) => line.startsWith('{"issue"'))
    .map((line) => JSON.parse(line))
    .at(-1);
}

// The orchestrator schedules stages only: it relays no task request, so
// each Integration a merge job requests is relayed here, as the caller
// relays it (#186). A failed CI check on the first hardened head returns
// the work to Hardening, which fixes it as a new revision.
const RELAYED = {
  end: "wait",
  request: "Integration",
  task: { end: "next", verdict: "passed" },
};
const STEPS = [
  { stage: "author", relayed: null },
  { stage: "implement", relayed: null },
  { stage: "review", relayed: null },
  { stage: "merge", relayed: RELAYED },
  { stage: "merge", relayed: null },
  { stage: "review", relayed: null },
  { stage: "merge", relayed: RELAYED },
  { stage: "merge", relayed: null },
];
/** @type {any[]} the task jobs' lines */
const relayed = [];

/**
 * One tick of `stage`, and, when `relay`, the relay of the task its job
 * requested, with what the job and the task job ended as.
 * @param {string} stage @param {boolean} relay
 */
async function tickStep(stage, relay) {
  const result = await completeStage(stage);
  const line = lastJobLine();
  if (!relay) {
    return { result, relayed: null };
  }
  const task = runTask(flow, stage, line.request, { lane: "orchestrator" });
  relayed.push(task);
  return {
    result,
    relayed: {
      end: line.end,
      request: line.request?.task,
      task: { end: task.end, verdict: task.task?.verdict },
    },
  };
}
for (const [at, step] of STEPS.entries()) {
  const requests = [", which requests Integration", ""][
    Number(step.relayed === null)
  ];
  test(`legacy tick ${at + 1} completes the ${step.stage} stage${requests}`, async () => {
    const outcome = await tickStep(step.stage, step.relayed !== null);
    assert.deepEqual(outcome.result.started, [step.stage], outcome.result.log);
    assert.deepEqual(outcome.relayed, step.relayed);
  });
}

test("completed legacy flow goes idle without another job", async () => {
  const result = await tick(flow);
  assert.deepEqual(result.started, [], jobLog(flow));
});

test("legacy ticks run development, hardening, read-only Integration and security, and a failed check returns to Hardening", () => {
  assert.deepEqual(
    stages,
    STEPS.map(({ stage }) => stage),
    jobLog(flow),
  );
  assert.deepEqual(
    relayed.map(({ task }) => [task.task, task.verdict]),
    [
      ["Integration", "passed"],
      ["Integration", "passed"],
    ],
  );
  const [first, second] = relayed;
  assert.notEqual(
    first.task.binding.revision.code,
    second.task.binding.revision.code,
  );
});

test("each phase gets its configured model and exact write authority without a GitHub token", () => {
  const starts = piStarts(flow);
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

test("hardening, its check fix and final security get pinned pages and truthful revision provenance", () => {
  const starts = piStarts(flow);
  const pages = PROMPT_PAGES.map(({ page }) => page);
  pages.splice(pages.length - 1, 0, "hardening.md");
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
  const [, , harden, reharden, security] = piLog(flow.piDir).filter(
    (entry) => "prompt" in entry,
  );
  assert.match(String(harden?.prompt), GHERKIN_IN_PROMPT);
  assert.ok(reharden !== undefined);
  assert.match(String(reharden.prompt), GHERKIN_IN_PROMPT);
  assert.match(String(reharden.prompt), CI_RETURN);
  const state = savedState(readWorld(flow.ghDir));
  assert.ok(String(security?.prompt).includes(state.hardened.code));
  assert.equal("wiki" in state.merged, false);
  assert.equal(state.integration, null);
  assert.deepEqual(state.security.revision, state.hardened);
  assert.equal(state.security.finding, null);
  assert.ok(state.security.commentId > 0);
  const tag = `review-security-${state.hardened.code.slice(0, SECURITY_TAG_LENGTH)}`;
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

test("a failed CI check loses authority until Hardening fixes it as a new revision with its own target and results", () => {
  const [, , firstHardening, integrated, ciReturn, reviewCheckpoint] =
    checkpoints;
  assert.ok(firstHardening !== undefined);
  assert.ok(integrated !== undefined);
  assert.ok(ciReturn !== undefined);
  assert.ok(reviewCheckpoint !== undefined);
  assert.equal(firstHardening.stage, "merge");
  assert.equal(integrated.stage, "merge");
  assert.equal(ciReturn.stage, "review");
  assert.equal(ciReturn.hardened, null);
  assert.equal(ciReturn.verifiedSha, null);
  assert.equal(ciReturn.mergeReturn?.reason, "ci");
  assert.equal(reviewCheckpoint.stage, "merge");
  assert.equal(reviewCheckpoint.mergeReturn, null);
  assert.notEqual(
    reviewCheckpoint.hardened?.code,
    firstHardening.hardened?.code,
  );
  assert.equal(reviewCheckpoint.integration, null);
  assert.deepEqual(reviewCheckpoint.hardenedTarget, {
    repo: "o/r",
    branch: BASE,
    sha: start,
  });
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
      mergedHead: state.hardened.code,
      merged: { ...state.hardened, code: pr.mergeOid },
      issue: ["closed", "completed", ["agent:merged"]],
      reviews: 2,
      unsupported: [],
    },
  );
});

test("one native target update lands the exact authorized head with no REST merge fallback", () => {
  const world = readWorld(flow.ghDir);
  const { hardened, mergeAttempt, hardenedTarget } = savedState(world);
  assert.equal(mergeAttempt.operation.kind, "fast-forward");
  assert.equal(mergeAttempt.operation.base, start);
  assert.equal(hardenedTarget.sha, start);
  assert.equal(mergeAttempt.authorized.code, hardened.code);
  assert.equal(
    ghCalls(flow.ghDir).some(
      ([command, endpoint = ""]) =>
        command === "api" && MERGE_ENDPOINT.test(endpoint),
    ),
    false,
  );
  assert.deepEqual(nativeTargetUpdates(world), [
    {
      origin: flow.origin,
      ref: `refs/heads/${BASE}`,
      old: start,
      head: hardened.code,
    },
  ]);
});

test("git lands exact H strictly after the retained base with the whole multi-commit code and docs contribution", () => {
  const base = baseHead(flow);
  const { merged, hardened } = savedState(readWorld(flow.ghDir));
  assert.equal(base, merged.code);
  assert.equal(base, hardened.code);
  assert.notEqual(base, start);
  assert.equal(bareGit(flow.origin, ["merge-base", start, base]), start);
  assert.ok(
    Number(bareGit(flow.origin, ["rev-list", "--count", `${start}..${base}`])) >
      1,
  );
  const greeting = bareGit(flow.origin, ["show", `${base}:greet.txt`]);
  assert.equal(greeting, "Hello, world!");
  const page = bareGit(flow.origin, ["show", `${base}:docs/Home.md`]);
  assert.match(page, MERGED_PAGE);
});

test("a completion replayed on a reopened done issue closes it again with no model, merging nothing new", async () => {
  const completedWorld = readWorld(flow.ghDir);
  assert.equal(savedState(completedWorld).stage, "done");
  assert.deepEqual(
    savedState(completedWorld).security.revision,
    savedState(completedWorld).merged,
  );
  const updates = nativeTargetUpdates(completedWorld);
  const done = baseHead(flow);
  const receipt = savedState(completedWorld).merged;
  withWorld(flow.ghDir, (reopened) => {
    const issue = reopened.issues.find(({ number }) => number === ISSUE);
    Object.assign(issue ?? {}, {
      state: "open",
      stateReason: null,
      labels: [],
    });
  });
  const sessions = piStarts(flow).length;
  const { started } = await tick(flow);
  const world = readWorld(flow.ghDir);
  const issue = world.issues.find(({ number }) => number === ISSUE);
  assert.deepEqual(nativeTargetUpdates(world), updates);
  assert.equal(
    ghCalls(flow.ghDir).some(
      ([command, endpoint = ""]) =>
        command === "api" && MERGE_ENDPOINT.test(endpoint),
    ),
    false,
  );
  assert.deepEqual(started, ["merge"], jobLog(flow));
  assert.equal(piStarts(flow).length, sessions);
  assert.equal(baseHead(flow), done);
  assert.equal(world.prs.length, 1);
  assert.equal(issue?.state, "closed");
  assert.equal(savedState(world).stage, "done");
  assert.deepEqual(savedState(world).merged, receipt);
  assert.deepEqual(world.unsupported, []);
});
