// @ts-check
// Model failure/cannot-fix go through the real merge role and credentialed sync ops.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { close } from "./job-checkout-dropped-test-kit.mjs";
import { resolverContext } from "./merge-resolver-retention-test-kit.mjs";
import { git, headOf } from "./pipeline-commit-test-kit.mjs";
import {
  conflicted,
  recovered,
  recoveryOf,
} from "./sync-retention-test-kit.mjs";

const { syncCode } = await import("../src/roles/merge/sync.ts");
const UNMERGED = /unmerged.*retain/u;
const STAGES = z.array(
  z.object({
    file: z.string(),
    mode: z.string(),
    sha: z.string(),
    stage: z.string(),
  }),
);

/** @param {ReturnType<typeof conflicted>} w */
function unresolvedState(w) {
  const index = git(w.dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  return {
    head: headOf(w.dir),
    unmerged: git(w.dir, ["ls-files", "--unmerged"]),
    index: fs.readFileSync(index),
    working: fs.readFileSync(path.join(w.dir, w.file)),
  };
}

test("code failed model session preserves its partial resolution through ordinary exit", async () => {
  const w = conflicted();
  const { ctx, ops, saved } = resolverContext(w, true);
  const result = await syncCode(ctx, ctx.state, 1);
  assert.ok(!result.ok);
  assert.equal(result.end.kind, "stop");
  assert.ok(ops.includes("finish-sync"));
  assert.deepEqual(saved, []);
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

test("code cannot-fix preserves the failed attempt and retains an unresolved retry on exit", async () => {
  const w = conflicted(true);
  const { ctx, ops, saved } = resolverContext(w, false);
  await assert.rejects(syncCode(ctx, ctx.state, 1), UNMERGED);
  assert.ok(ops.includes("finish-sync"));
  assert.ok(ops.includes("sync-base"));
  assert.deepEqual(
    saved.map((state) => state.counts.conflictFixes),
    [1],
  );
  await assert.rejects(close(w.job, "cannot-exit"), UNMERGED);
  const { folder, repo } = recoveryOf(w);
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
  assert.equal(fs.existsSync(w.job.root), true);
});

test("code unresolved retry retains its exact checkout, numbered stages and self-contained history", async () => {
  const w = conflicted(true);
  const { ctx } = resolverContext(w, false);
  await assert.rejects(syncCode(ctx, ctx.state, 1), UNMERGED);
  const before = unresolvedState(w);
  assert.notEqual(before.unmerged, "");
  await assert.rejects(close(w.job, "cannot-exit"), UNMERGED);
  assert.deepEqual(unresolvedState(w), before);
  const { folder, repo } = recoveryOf(w, "conflict-stages.json");
  const stages = STAGES.parse(
    JSON.parse(
      fs.readFileSync(path.join(folder, "conflict-stages.json"), "utf8"),
    ),
  );
  assert.equal(
    stages
      .map(
        (entry) => `${entry.mode} ${entry.sha} ${entry.stage}\t${entry.file}`,
      )
      .join("\n"),
    before.unmerged,
  );
  assert.equal(git(repo, ["cat-file", "-t", w.original]), "commit");
  assert.equal(git(repo, ["cat-file", "-t", before.head]), "commit");
  assert.equal(fs.existsSync(path.join(folder, "working.patch")), false);
  assert.equal(
    git(w.origin, ["rev-parse", `refs/heads/${w.job.branch}`]),
    w.remote,
  );
  assert.equal(fs.existsSync(w.job.root), true);
});
