// @ts-check
// The issue branch the stage job's caller assigns it (src/job/branch.ts):
// required for a run and for --print-boundary, and refused, with the job
// exiting 1 before it runs an op, opens job.json or clones anything, when
// git wouldn't take it literally, when the repo protects it (its configured
// base, the remote's default branch). A branch it takes is
// the one its checkout is on and every ops request names; the claim refuses
// one the saved state isn't bound to.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AUTHOR_SESSION, READER_STAGE, repliesAt } from "../job-fixtures.mjs";
import { checkoutOf } from "../job-git-test-kit.mjs";
import { logOf, runJob, setUp } from "./job-test-kit.mjs";

const ISSUE_BRANCH = "agent/issue-7";
const NO_BRANCH = /--branch must name the issue's branch/u;
// paths.branch's refusals (src/config.ts), which every op applies too.
const NOT_LITERAL = /--branch: #7's branch .* is not a literal branch name/u;
const PROTECTED = /--branch: #7's branch .* is the base branch/u;
// git's, for a name past that rule.
const NOT_VALID = /is not a valid branch name/u;
const DEFAULT_BRANCH = /is o\/r's default branch/u;

// A job whose claim would run the author, so a refusal is the only reason
// it runs nothing.
function place() {
  return setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
}

/**
 * How the job in `at` ended, `r`, and what it touched: its ops, its pis,
 * its job.json and its checkout.
 * @param {ReturnType<typeof place>} at
 * @param {{ status: number | null, stderr: string }} r
 * @param {RegExp} pattern the refusal its stderr should name
 */
function refusalOf(at, r, pattern) {
  const touched = [
    ["ops", logOf(at, "ops.log").length > 0],
    ["pi", logOf(at, "pi.log").length > 0],
    ["job.json", fs.existsSync(path.join(at.runDir, "job.json"))],
    ["checkout", fs.existsSync(checkoutOf(at.root, READER_STAGE))],
  ].filter(([, was]) => was);
  return { status: r.status, named: pattern.test(r.stderr), touched };
}

const REFUSED = { status: 1, named: true, touched: [] };

test("a run or a boundary print without --branch is refused before anything runs", () => {
  const at = place();
  for (const args of [
    ["--stage", READER_STAGE, "--branch", ""],
    ["--stage", READER_STAGE, "--print-boundary", "--branch", ""],
  ]) {
    assert.deepEqual(refusalOf(at, runJob(at, args), NO_BRANCH), REFUSED);
  }
});

test("a branch git wouldn't take literally as a branch name is refused before anything runs", () => {
  const at = place();
  const refused = [
    ["-delete", NOT_LITERAL],
    ["refs/heads/agent/issue-7", NOT_LITERAL],
    ["HEAD", NOT_LITERAL],
    ["@{-1}", NOT_LITERAL],
    ["agent/issue..7", NOT_LITERAL],
    ["agent/issue-7.lock", NOT_LITERAL],
    ["agent issue-7", NOT_LITERAL],
    ["agent.lock/issue-7", NOT_VALID],
  ];
  for (const [branch, pattern] of refused) {
    const r = runJob(at, ["--stage", READER_STAGE, `--branch=${branch}`]);
    const refusal = refusalOf(at, r, /** @type {RegExp} */ (pattern));
    assert.deepEqual(refusal, REFUSED, `${branch}: ${r.stderr}`);
  }
});

test("the configured base is refused, for a run and a boundary print", () => {
  const at = place();
  for (const extra of [[], ["--print-boundary"]]) {
    const args = ["--stage", READER_STAGE, "--branch", "integration", ...extra];
    assert.deepEqual(refusalOf(at, runJob(at, args), PROTECTED), REFUSED);
  }
});

test("an assigned branch other than the legacy one is the branch the checkout is on and every ops request names", () => {
  const at = place();
  const branch = "feature/issue-7-query";
  const r = runJob(at, ["--stage", READER_STAGE, "--branch", branch]);
  assert.equal(r.status, 0, r.stderr);
  const requests = logOf(at, "ops.log");
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.checkout.branch, branch, request.op);
  }
  const starts = logOf(at, "pi.log").filter((entry) => "argv" in entry);
  assert.deepEqual(
    starts.map((start) => start.branch),
    [branch],
    r.stdout,
  );
});

test("a run on the remote's default branch is refused, as the remote names it", () => {
  const at = place();
  const sha = execFileSync(
    "git",
    ["--git-dir", at.origin, "rev-parse", "refs/heads/integration"],
    { encoding: "utf8" },
  ).trim();
  const origin = ["--git-dir", at.origin];
  execFileSync("git", [
    ...origin,
    "update-ref",
    `refs/heads/${ISSUE_BRANCH}`,
    sha,
  ]);
  execFileSync("git", [
    ...origin,
    "symbolic-ref",
    "HEAD",
    `refs/heads/${ISSUE_BRANCH}`,
  ]);
  const r = runJob(at, ["--stage", READER_STAGE, "--branch", ISSUE_BRANCH]);
  const refusal = refusalOf(at, r, DEFAULT_BRANCH);
  assert.deepEqual(refusal, REFUSED, r.stderr);
});

test("the issue's own branch runs, and its boundary prints", () => {
  const at = place();
  const boundary = runJob(at, ["--stage", READER_STAGE, "--print-boundary"]);
  assert.equal(boundary.status, 0, boundary.stderr);
  const r = runJob(at, ["--stage", READER_STAGE, "--branch", ISSUE_BRANCH]);
  assert.equal(r.status, 0, r.stderr);
  const [claim] = logOf(at, "ops.log");
  assert.equal(claim.checkout.branch, ISSUE_BRANCH);
});
