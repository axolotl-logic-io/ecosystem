// @ts-check
// pipeline_commit refuses a commit to a checkout the stage only reads
// (commit-needs-write-access, #338), and a repo with no wiki gets no docs/
// (Pipeline-Roles-Shared, "pipeline_commit" and "Wiki provisioning").
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

/** @import { StageName } from "../src/workflow/stages/types.ts" */

// A stage, a file in a checkout it only reads, and what the refusal names.
/** @type {[StageName, string, RegExp][]} */
const READ_ONLY_COMMITS = [
  ["sync", "docs/Page.md", /read access to the wiki checkout \(docs\/\)/u],
  ["merge", "repo/README.md", /read access to the code checkout \(repo\/\)/u],
];

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

test("a repo with no wiki gets a job folder with repo/ and no docs/", () => {
  const tmp = fs.mkdtempSync(path.join(root, "repo-"));
  const cfg = configIn(tmp, false);
  const dirs = openJobCheckout(cfg, ISSUE, {
    stage: "implement",
    stackOn: null,
  });
  assert.equal(dirs.docs, null);
  assert.ok(fs.existsSync(path.join(dirs.root, "repo", ".git")));
  assert.ok(!fs.existsSync(path.join(dirs.root, "docs")));
  assert.ok(!fs.existsSync(path.join(dirs.root, ".git")));
});
