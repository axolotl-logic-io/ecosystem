// @ts-check
// The job-level moved-branch guard must leave uncertain merge evidence to
// bounded recovery, not stop before the merge role can read the retained PR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { consumed, script } from "../explicit-target-test-kit.mjs";
import { BRANCH, git, PR, world } from "../explicit-target-world-test-kit.mjs";

const { branchMoved } = await import("../../src/job/role-end.ts");
const { beginMerge } = await import("../../src/ops/merge-attempt.ts");

test("an attempted merge reaches read-only recovery despite movement of the mutable source branch", () => {
  const w = world();
  script(w, []);
  const attempt = beginMerge(w.cfg, w.state.number, PR, {
    authorized: w.revision,
    base: w.base,
  });
  git(w.seed, ["push", "-q", "origin", `${w.moved}:refs/heads/${BRANCH}`]);
  assert.equal(attempt.codeMerged, null);
  assert.equal(attempt.merged, null);
  assert.equal(attempt.mergeAttempt?.authorized.code, w.head);
  assert.notEqual(w.moved, w.head);
  assert.equal(branchMoved(attempt, w.moved), null);
  assert.deepEqual(attempt.hardened, w.state.hardened);
  // Ordinary unattempted work still stops rather than adopting another actor's head.
  const refused = branchMoved(w.state, w.moved);
  assert.ok(refused?.kind === "stop");
  assert.equal(refused.code, "branch-changed");
  consumed();
});
