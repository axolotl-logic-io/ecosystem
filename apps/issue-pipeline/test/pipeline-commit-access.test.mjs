// @ts-check
// pipeline_commit refuses a commit to a checkout the stage only reads
// (commit-needs-write-access, #338), lets the reviewer's hardening and
// merge's integration commit both checkouts, and a repo with no wiki gets no
// docs/ (Pipeline-Roles-Shared, "pipeline_commit" and "Wiki provisioning").
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { refOf } from "./job-git-test-kit.mjs";
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
} from "./pipeline-commit-test-kit.mjs";

const { openJobCheckout } = await import("../src/job/checkout.ts");

/** @import { Stage } from "../src/stages.ts" */

const WIKI_READ_ONLY = /read access to the wiki checkout \(docs\/\)/u;
const CODE_READ_ONLY = /read access to the code checkout \(repo\/\)/u;
// A stage, a file in a checkout it only reads, and what the refusal names:
// the author, the one reader stage, reads both checkouts.
/** @type {[Stage, string, RegExp][]} */
const READ_ONLY_COMMITS = [
  ["author", "docs/Page.md", WIKI_READ_ONLY],
  ["author", "repo/README.md", CODE_READ_ONLY],
];
// The stages besides the implement stage whose committing sessions commit
// both checkouts: the reviewer's hardening and merge's integration.
/** @type {Stage[]} */
const HARDENING_STAGES = ["review", "merge"];

for (const [stage, file, refusal] of READ_ONLY_COMMITS) {
  test(`the ${stage} stage's commit of ${file} is refused, naming the checkout and the access, and changes nothing`, async () => {
    const job = await openJob(stage);
    try {
      const heads = [headOf(job.repo), headOf(job.docs)];
      write(job.root, file, "changed\n");
      const call = job.commit(["-m", "Refused", "--", file]);
      await assert.rejects(call, refusal);
      assert.deepEqual([headOf(job.repo), headOf(job.docs)], heads);
      for (const dir of [job.repo, job.docs]) {
        assert.equal(git(dir, ["diff", "--cached", "--name-only"]), "");
      }
      assert.equal(refOf(job.origin, BRANCH), "");
      assert.equal(refOf(job.wikiOrigin, BRANCH), "");
      assert.deepEqual(pushesOf(job), []);
    } finally {
      job.close();
    }
  });
}

for (const stage of HARDENING_STAGES) {
  test(`the ${stage} stage's committing session commits code and the wiki`, async () => {
    const job = await openJob(stage);
    try {
      write(job.repo, "README.md", "hardened\n");
      write(job.docs, "Page.md", "hardened\n");
      const result = await job.commit(["-am", "Harden"]);
      assert.equal(result.isError, false);
      assert.equal(result.details.pushed, "both");
      assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
      assert.equal(refOf(job.wikiOrigin, BRANCH), headOf(job.docs));
    } finally {
      job.close();
    }
  });
}

test("a repo with no wiki gets a job folder with repo/ and no docs/", () => {
  const tmp = fs.mkdtempSync(path.join(root, "repo-"));
  const cfg = configIn(tmp, false);
  const dirs = openJobCheckout(cfg, ISSUE, { stage: "implement" });
  assert.equal(dirs.docs, null);
  assert.ok(fs.existsSync(path.join(dirs.root, "repo", ".git")));
  assert.ok(!fs.existsSync(path.join(dirs.root, "docs")));
  assert.ok(!fs.existsSync(path.join(dirs.root, ".git")));
});
