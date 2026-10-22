// @ts-check
// Staged bytes survive independently of the final working tree, in code and
// in its docs/.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  close,
  KEY,
  openFresh,
  restored,
} from "../job-checkout-dropped-test-kit.mjs";
import { git, headOf, ISSUE, write } from "../pipeline-commit-test-kit.mjs";

const { paths } = await import("../../src/config.ts");

for (const tracked of ["README.md", "docs/Home.md"]) {
  for (const working of ["HEAD", "distinct"]) {
    test(`${tracked}: staged content survives cleanup with ${working} working bytes`, async () => {
      const job = openFresh();
      const dir = job.repo;
      const { origin } = job;
      const sha = headOf(dir);
      const original = fs.readFileSync(path.join(dir, tracked));
      write(dir, tracked, "unique staged bytes\n");
      git(dir, ["add", tracked]);
      let bytes = original;
      if (working === "distinct") {
        bytes = Buffer.from("distinct working bytes\n");
      }
      fs.writeFileSync(path.join(dir, tracked), bytes);
      const result = await close(job, KEY);
      const patch = paths.droppedPatch(job.cfg, ISSUE, KEY, "repo");
      const indexPatch = `${patch}.index.patch`;
      assert.equal(fs.existsSync(indexPatch), true);
      assert.ok(result.patches.some((file) => file.endsWith(".index.patch")));
      const index = restored(origin, sha, indexPatch);
      assert.equal(
        fs.readFileSync(path.join(index, tracked), "utf8"),
        "unique staged bytes\n",
      );
      assert.equal(fs.existsSync(patch), working === "distinct");
      git(index, ["reset", "--hard", sha]);
      if (working === "distinct") {
        git(index, ["apply", "--index", patch]);
      }
      assert.deepEqual(fs.readFileSync(path.join(index, tracked)), bytes);
      assert.equal(fs.existsSync(job.root), false);
    });
  }
}
