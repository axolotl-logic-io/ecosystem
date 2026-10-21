// @ts-check
// Failed resolver work survives actual sync operations and ordinary job teardown.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { close } from "./job-checkout-dropped-test-kit.mjs";
import { git, headOf } from "./pipeline-commit-test-kit.mjs";
import {
  completeRebase,
  conflicted,
  finish,
  leaveResolution,
  recovered,
} from "./sync-retention-test-kit.mjs";

const UNMERGED = /unmerged.*retain/u;

for (const abort of [false, true]) {
  for (const completed of [false, true]) {
    test(`code resolver abort ${abort}, completed rebase ${completed}: index/work bytes and original commits survive teardown`, async () => {
      const w = conflicted();
      if (completed) {
        completeRebase(w);
      }
      leaveResolution(w);
      const result = finish(w, abort);
      assert.equal("resolved" in result && result.resolved, false);
      assert.equal(headOf(w.dir), w.remote);
      const { folder, repo } = await recovered(w);
      assert.equal(git(repo, ["cat-file", "-t", w.original]), "commit");
      git(repo, ["apply", "--index", path.join(folder, "working.patch")]);
      assert.equal(
        fs.readFileSync(path.join(repo, w.file), "utf8"),
        "unique working resolution\n",
      );
      assert.equal(
        fs.readFileSync(path.join(repo, "resolver-notes.txt"), "utf8"),
        "untracked resolution notes\n",
      );
      git(repo, ["reset", "--hard", "HEAD"]);
      git(repo, ["clean", "-fd"]);
      git(repo, [
        "apply",
        "--index",
        path.join(folder, "working.patch.index.patch"),
      ]);
      assert.equal(
        fs.readFileSync(path.join(repo, w.file), "utf8"),
        "unique staged resolution\n",
      );
      assert.equal(
        git(w.origin, ["rev-parse", `refs/heads/${w.job.branch}`]),
        w.remote,
      );
      assert.equal(fs.existsSync(w.job.root), false);
    });
  }
}
test("code unresolved index refuses destructive abort and retains the exact checkout on exit", async () => {
  const w = conflicted();
  const index = git(w.dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  const before = fs.readFileSync(index);
  const bytes = fs.readFileSync(path.join(w.dir, w.file));
  writeNotes(w.dir);
  const head = headOf(w.dir);
  assert.throws(() => finish(w, true), UNMERGED);
  await assert.rejects(close(w.job, "unresolved-exit"), UNMERGED);
  assert.equal(headOf(w.dir), head);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.deepEqual(fs.readFileSync(path.join(w.dir, w.file)), bytes);
  assert.equal(
    fs.readFileSync(path.join(w.dir, "resolver-notes.txt"), "utf8"),
    "partial work\n",
  );
  assert.equal(fs.existsSync(w.job.root), true);
  assert.equal(
    git(w.origin, ["rev-parse", `refs/heads/${w.job.branch}`]),
    w.remote,
  );
});

/** @param {string} dir */
function writeNotes(dir) {
  fs.writeFileSync(path.join(dir, "resolver-notes.txt"), "partial work\n");
}
