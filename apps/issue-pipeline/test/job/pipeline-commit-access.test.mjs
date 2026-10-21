// @ts-check
// pipeline_commit refuses a commit to a checkout the stage only reads
// (commit-needs-write-access, #338), lets the reviewer's hardening and
// merge's integration commit code and its docs/, and a job folder holds
// repo/ alone (Pipeline-Job-Contract#pipeline_commit).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { refOf } from "../job-git-test-kit.mjs";
import {
  BRANCH,
  configIn,
  git,
  headOf,
  ISSUE,
  openJob,
  pushesOf,
  root,
  write,
} from "../pipeline-commit-test-kit.mjs";

const { openJobCheckout } = await import("../../src/job/checkout.ts");

/** @import { Stage } from "../../src/stages.ts" */

const CODE_READ_ONLY = /read access to the code checkout \(repo\/\)/u;
// A stage, a file in a checkout it only reads, and what the refusal names:
// the author, the one reader stage, reads the code and its docs.
/** @type {[Stage, string, RegExp][]} */
const READ_ONLY_COMMITS = [
  ["author", "repo/docs/Home.md", CODE_READ_ONLY],
  ["author", "repo/README.md", CODE_READ_ONLY],
];
// The stages besides the implement stage whose committing sessions commit
// code and its docs: the reviewer's hardening and merge's integration.
/** @type {Stage[]} */
const HARDENING_STAGES = ["review", "merge"];

for (const [stage, file, refusal] of READ_ONLY_COMMITS) {
  test(`the ${stage} stage's commit of ${file} is refused, naming the checkout and the access, and changes nothing`, async () => {
    const job = await openJob(stage);
    try {
      const head = headOf(job.repo);
      write(job.root, file, "changed\n");
      const call = job.commit(["-m", "Refused", "--", file]);
      await assert.rejects(call, refusal);
      assert.equal(headOf(job.repo), head);
      assert.equal(git(job.repo, ["diff", "--cached", "--name-only"]), "");
      assert.equal(refOf(job.origin, BRANCH), "");
      assert.deepEqual(pushesOf(job), []);
    } finally {
      job.close();
    }
  });
}

for (const stage of HARDENING_STAGES) {
  test(`the ${stage} stage's committing session commits code and its docs in one commit`, async () => {
    const job = await openJob(stage);
    try {
      write(job.repo, "README.md", "hardened\n");
      write(job.repo, "docs/Home.md", "hardened\n");
      const result = await job.commit(["-am", "Harden"]);
      assert.equal(result.isError, false);
      assert.equal(result.details.pushed, "code");
      assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
      assert.equal(
        git(job.repo, ["show", "--name-only", "--format=", "HEAD"]),
        "README.md\ndocs/Home.md",
      );
    } finally {
      job.close();
    }
  });
}

test("a job folder holds repo/ and no docs/ beside it", () => {
  const tmp = fs.mkdtempSync(path.join(root, "repo-"));
  const cfg = configIn(tmp);
  const dirs = openJobCheckout(cfg, ISSUE, {
    stage: "implement",
    branch: `agent/issue-${ISSUE}`,
  });
  assert.ok(fs.existsSync(path.join(dirs.root, "repo", ".git")));
  assert.ok(!fs.existsSync(path.join(dirs.root, "docs")));
  assert.ok(!fs.existsSync(path.join(dirs.root, ".git")));
});
