// @ts-check
// Model failure/cannot-fix go through the real merge role and credentialed sync ops.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { close } from "./job-checkout-dropped-test-kit.mjs";
import { resolverContext } from "./merge-resolver-retention-test-kit.mjs";
import { git, headOf } from "./pipeline-commit-test-kit.mjs";
import {
  conflicted,
  recovered,
  recoveryOf,
} from "./sync-retention-test-kit.mjs";

const { syncSide } = await import("../src/roles/merge/sync.ts");
const UNMERGED = /unmerged.*retain/u;

/** @param {ReturnType<typeof conflicted>} w */
function conflictOf(w) {
  return {
    conflict: /** @type {const} */ (true),
    changed: false,
    inRebase: true,
    conflicts: [w.file],
    baseSha: headOf(w.dir),
  };
}

for (const [side, finishName, startName] of /** @type {const} */ ([
  ["code", "finish-sync", "sync-base"],
  ["wiki", "finish-wiki-sync", "wiki-sync"],
])) {
  test(`${side} failed model session preserves its partial resolution through ordinary exit`, async () => {
    const w = conflicted(side);
    const { ctx, ops, saved } = resolverContext(w, true);
    const result = await syncSide(ctx, ctx.state, {
      side,
      first: conflictOf(w),
      maxConflictFixes: 1,
    });
    assert.ok(!result.ok);
    assert.equal(result.end.kind, "stop");
    assert.ok(ops.includes(finishName));
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

  test(`${side} cannot-fix preserves the failed attempt and retains an unresolved retry on exit`, async () => {
    const w = conflicted(side, true);
    const { ctx, ops, saved } = resolverContext(w, false);
    await assert.rejects(
      syncSide(ctx, ctx.state, {
        side,
        first: conflictOf(w),
        maxConflictFixes: 1,
      }),
      UNMERGED,
    );
    assert.ok(ops.includes(finishName));
    assert.ok(ops.includes(startName));
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
}
