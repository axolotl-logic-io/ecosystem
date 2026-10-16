// @ts-check
// verify of a stacked branch (#268), one cut from its prerequisite issue's
// branch: its changed files and the fails-before-fix check measure the
// branch's own change from the prerequisite's head, not from the base.
import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { setEnv } from "./ops-run-test-kit.mjs";
import { ask, sh, verifyKit, writeConfig } from "./verify-test-kit.mjs";

const root = fs.mkdtempSync("/tmp/issue-pipeline-verify-stacked-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
setEnv("ISSUE_PIPELINE_ROOT", root);
const kit = verifyKit(root);
// The issue stacked on the prerequisite, numbered past those kit.branch makes.
const DEPENDENT = 90;
// Verify's reply, read as far as this test takes it apart.
const VERIFY_REPLY = z.looseObject({
  ok: z.boolean(),
  changedFiles: z.array(z.string()).optional(),
  checks: z.array(z.looseObject({ id: z.string() })).optional(),
});

// Pushes the dependent's branch, cut from prerequisite `prereq`'s branch,
// with a docs change of its own, and checks it out at its worktree.
/** @param {number} prereq @returns {void} */
function stackedBranch(prereq) {
  const seed = `${root}/seed`;
  const clone = `${root}/clones/o__r`;
  const branch = `agent/issue-${DEPENDENT}`;
  sh(
    `cd ${seed} && git checkout -q -b ${branch} agent/issue-${prereq} && echo again >> README.md && git commit -qam docs && git push -q origin ${branch}`,
  );
  sh(
    `git -C ${clone} fetch -q origin && git -C ${clone} worktree add -q -b ${branch} ${kit.worktree(DEPENDENT)} origin/${branch}`,
  );
}

test("a stacked verify leaves the prerequisite's files out of its changed files and fails-before-fix", () => {
  // The prerequisite's code change, with no tests, which the dependent's
  // own check doesn't judge.
  const { n: prereq, sha: prereqHead } = kit.branch({ "src/p.js": "p\n" });
  stackedBranch(prereq);
  const config = writeConfig(root, DEPENDENT, {});
  const stackedOn = { issue: prereq, headSha: prereqHead };
  const request = { op: "verify", config, number: DEPENDENT, stackedOn };
  const reply = VERIFY_REPLY.parse(ask(root, request));
  assert.deepEqual(reply.changedFiles, ["README.md"]);
  const check = reply.checks?.find((c) => c.id === "fails-before-fix");
  assert.deepEqual(check, {
    id: "fails-before-fix",
    pass: true,
    detail: "no code changes; skipped",
  });
});
