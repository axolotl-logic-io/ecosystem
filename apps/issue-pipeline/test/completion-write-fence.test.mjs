// @ts-check
// PR ready and Completion's source-branch delete reread ownership first
// (#169, #133), in the full-flow world with a real origin: each row is the
// op's own success setup, but a successor takes the issue just after the
// request's ownership check. The write never happens, the refusal names the
// lost ownership, and GitHub and the origin are unchanged. The same request
// without the takeover then succeeds, so the setup was a real success.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { ISSUE, integrationWorld } from "./integration-task-test-kit.mjs";
import { isCoordinationWrite } from "./pipeline-flow-coordination-test-kit.mjs";
import { savedState } from "./pipeline-flow-script-test-kit.mjs";
import {
  callMark,
  loseNextOwnership,
  plantComment,
  rawOps,
  runId,
  stateText,
} from "./task-results-test-kit.mjs";

const REFUSED = z.looseObject({ ok: z.literal(false), error: z.string() });
const DONE = z.looseObject({ ok: z.literal(true) });
// What the fresh ownership read before a write says once a successor took
// the issue (coordination-records.ts).
const LOST = /execution ownership lost or unconfirmed/u;
const READ_ONLY_PR = new Set(["view", "list", "checks"]);
const COORDINATION = "<!-- agent-pipeline:coordination\n";
const OWNER = new URL("./fake-ownership-owner.mjs", import.meta.url).pathname;

const world = integrationWorld();
const ready = world.readyToLand();

/** @param {number} mark @returns {string[][]} the writes since `mark`, but coordination's */
function writes(mark) {
  return ghCalls(world.flow.ghDir)
    .slice(mark)
    .filter((args) => !isCoordinationWrite(args))
    .filter(
      (args) =>
        (args[0] === "pr" && !READ_ONLY_PR.has(String(args[1]))) ||
        args.includes("-X"),
    );
}

// Releases the successor that took the issue, as its job would once done,
// so the same request can run again under a new owner.
function releaseSuccessor() {
  const rows = readWorld(world.flow.ghDir)
    .comments.filter(({ body }) => body.startsWith(COORDINATION))
    .map(({ body }) => JSON.parse(body.split("\n")[1] ?? ""));
  const successor = rows.findLast(
    ({ kind, identity }) => kind === "request" && identity.lane === "successor",
  );
  const frame = {
    config: world.flow.config,
    number: ISSUE,
    checkout: { issue: ISSUE, dir: world.wt, branch: world.branch },
    execution: successor.identity,
  };
  const released = spawnSync(process.execPath, [OWNER, "release"], {
    input: JSON.stringify(frame),
    encoding: "utf8",
    env: Object.fromEntries([
      ...Object.entries(world.flow.env),
      ["FAKE_OWNERSHIP_QUIET", "1"],
    ]),
  });
  if (released.status !== 0) {
    throw new Error(`the successor didn't release: ${released.stderr}`);
  }
}

/** @returns {import("./fake-pipeline-flow-gh-world.mjs").FlowPr | undefined} */
function pullRequest() {
  return readWorld(world.flow.ghDir).prs.find(
    ({ number }) => number === ready.pr,
  );
}

test("PR ready: a successor taking the issue before the ready leaves the PR a draft", () => {
  withWorld(world.flow.ghDir, (gh) => {
    const pr = gh.prs.find(({ number }) => number === ready.pr);
    if (pr !== undefined) {
      pr.isDraft = true;
    }
  });
  const request = { op: "ready-pr", number: ISSUE, state: ready.state };
  const mark = callMark(world.flow.ghDir);
  loseNextOwnership(world.flow);
  assert.match(REFUSED.parse(rawOps(world.flow, request)).error, LOST);
  assert.equal(pullRequest()?.isDraft, true);
  assert.deepEqual(writes(mark), []);
  releaseSuccessor();
  DONE.parse(rawOps(world.flow, request));
  assert.equal(pullRequest()?.isDraft, false);
});

test("Completion: a successor taking the issue before the branch delete leaves the branch and the issue", () => {
  for (const task of ["Hardening", "Integration", "Security"]) {
    world.passed(task);
  }
  const landed = world.land(ready, {
    binding: world.bound("Land"),
    landRun: { id: runId(), previous: null },
  });
  assert.equal(landed.merged, true, JSON.stringify(landed));
  const delivery = { pr: ready.pr, sha: String(landed.mergeCommit) };
  assert.equal(world.confirm(delivery, world.bound("Land")).confirmed, true);
  // The merge stage saves the issue done before Completion.
  const done = {
    ...savedState(readWorld(world.flow.ghDir)),
    stage: "done",
    lease: null,
  };
  plantComment(world.flow.ghDir, ISSUE, "bot", stateText(done));
  const request = { op: "finish", number: ISSUE, state: done };
  const branch = world.remoteBranch();
  assert.ok(branch);
  const mark = callMark(world.flow.ghDir);
  loseNextOwnership(world.flow);
  assert.match(REFUSED.parse(rawOps(world.flow, request)).error, LOST);
  assert.equal(world.remoteBranch(), branch);
  assert.equal(
    readWorld(world.flow.ghDir).issues.find(({ number }) => number === ISSUE)
      ?.state,
    "open",
  );
  assert.deepEqual(writes(mark), []);
  releaseSuccessor();
  DONE.parse(rawOps(world.flow, request));
  assert.equal(world.remoteBranch(), null);
});
