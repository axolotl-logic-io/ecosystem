import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { World } from "../explicit-target-world-test-kit.ts";
import { BASE, BRANCH, git, world } from "../explicit-target-world-test-kit.ts";

const { branchMerge }: typeof import("../../src/ops/branch-merge.ts") =
  await import("../../src/ops/branch-merge.ts");
const NON_ANCESTOR = /strict ancestor/u;
const WRONG_REPOSITORY = /configured GitHub repository HTTPS remote/u;
const LITERAL_TARGET = /literal configured target/u;
const INVALID_SHA = /Invalid string/u;

// Receive-pack records the actual wire old/new/ref, not the CLI's intentions.
function recordUpdates(w: World): string {
  const file = path.join(w.place, "received");
  fs.writeFileSync(
    path.join(w.origin, "hooks", "pre-receive"),
    `#!/bin/sh\ncat >> '${file}'\n`,
    { mode: 0o755 },
  );
  return file;
}

test("FF transport lands exactly reviewed multi-commit head on the literal target with exact old/new wire IDs", () => {
  const w = world({ fastForward: true });
  const received = recordUpdates(w);
  assert.equal(branchMerge(w.cfg, w.wt, w.base, w.head), true);
  assert.equal(
    fs.readFileSync(received, "utf8"),
    `${w.base} ${w.head} refs/heads/${BASE}\n`,
  );
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
  assert.equal(git(w.origin, ["rev-parse", "main"]), w.base);
  assert.equal(git(w.origin, ["rev-parse", BRANCH]), w.head);
});

for (const moved of ["ancestor", "descendant", "divergent"]) {
  test(`FF transport refuses target race to ${moved} without overwriting or a fallback`, () => {
    const w = world({ fastForward: true });
    const received = recordUpdates(w);
    let target = w.moved;
    if (moved === "ancestor") {
      target = git(w.wt, ["rev-parse", `${w.head}~1`]);
    }
    if (moved === "divergent") {
      git(w.seed, ["checkout", "-q", "--detach", w.base]);
      git(w.seed, ["commit", "--allow-empty", "-qm", "other actor"]);
      target = git(w.seed, ["rev-parse", "HEAD"]);
      git(w.seed, ["push", "-q", "origin", `${target}:refs/heads/other`]);
    }
    fs.rmSync(received, { force: true });
    git(w.origin, ["update-ref", `refs/heads/${BASE}`, target]);
    assert.equal(branchMerge(w.cfg, w.wt, w.base, w.head), false);
    assert.equal(git(w.origin, ["rev-parse", BASE]), target);
    assert.equal(git(w.origin, ["rev-parse", "main"]), w.base);
    assert.equal(fs.existsSync(received), false);
  });
}

test("FF lease never permits non-ancestor or already-equal replacement", () => {
  const w = world({ concurrent: true });
  const received = recordUpdates(w);
  assert.throws(() => branchMerge(w.cfg, w.wt, w.parent, w.head), NON_ANCESTOR);
  assert.throws(() => branchMerge(w.cfg, w.wt, w.head, w.head), NON_ANCESTOR);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(fs.existsSync(received), false);
});

test("FF transport refuses a wrong repository and nonliteral or nonimmutable bindings before mutation", () => {
  const w = world({ fastForward: true });
  const received = recordUpdates(w);
  assert.throws(
    () =>
      branchMerge({ ...w.cfg, baseBranch: "bad:target" }, w.wt, w.base, w.head),
    LITERAL_TARGET,
  );
  assert.throws(() => branchMerge(w.cfg, w.wt, "HEAD", w.head), INVALID_SHA);
  git(w.wt, [
    "remote",
    "set-url",
    "origin",
    "https://github.com/wrong/repo.git",
  ]);
  assert.throws(
    () => branchMerge(w.cfg, w.wt, w.base, w.head),
    WRONG_REPOSITORY,
  );
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(fs.existsSync(received), false);
});
