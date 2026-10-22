// @ts-check
// Saved authority, not the caller's claimed receipt, guards every merge effect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedOf, current, request } from "./merge-op-test-kit.mjs";
import {
  boundState,
  fakeGh,
  ISSUE,
  prView,
  savedListing,
  sh,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const MOVED_TARGET_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const { merge } = await import("../../src/ops/merge.ts");
const { readWriteState } = await import("../../src/saved-state.ts");

/** @param {import("../../src/state.ts").IssueState} saved @param {string} refusal */
function unclearedState(saved, refusal) {
  const { security } = saved;
  if (security?.target === undefined) {
    throw new Error("missing bound baseline Security target");
  }

  switch (refusal) {
    case "missing":
      saved.security = null;
      break;
    case "historical": {
      const { phase: _phase, target: _target, ...historical } = security;
      saved.security = historical;
      break;
    }
    case "rejected":
      security.finding = {
        category: "rights",
        reason: "Exports private data",
      };
      break;
    case "wrong code":
      security.revision = { ...security.revision, code: "unreviewed" };
      break;
    case "wrong inputs":
      security.revision = { ...security.revision, inputs: "stale-inputs" };
      break;
    case "wrong target":
      security.target.branch = "other";
      break;
    case "moved target":
      security.target.sha = MOVED_TARGET_SHA;
      break;
    case "unchecked":
      saved.verifiedSha = null;
      break;
    default:
      throw new Error(`unhandled case ${refusal}`);
  }
  return saved;
}

for (const refusal of [
  "missing",
  "historical",
  "rejected",
  "wrong code",
  "wrong inputs",
  "wrong target",
  "moved target",
  "unchecked",
]) {
  test(`saved ${refusal} clearance refuses before approval, attempt checkpoint or target mutation`, () => {
    const w = world();
    current(w);
    const baseline = boundState(w, approvedOf(w));
    const base = sh(`git -C ${w.worktree} rev-parse origin/integration`);
    assert.deepEqual(baseline.hardenedTarget, {
      repo: w.cfg.repo,
      branch: w.cfg.baseBranch,
      sha: base,
    });
    assert.ok(baseline.security);
    assert.equal(baseline.security.phase, "candidate");
    assert.deepEqual(baseline.security.target, baseline.hardenedTarget);
    assert.deepEqual(baseline.security.revision, approvedOf(w));
    assert.equal(baseline.security.finding, null);
    assert.equal(baseline.verifiedSha, w.sha);
    assert.notEqual(base, MOVED_TARGET_SHA);
    const saved = unclearedState(baseline, refusal);
    fakeGh.reply([
      { ...savedListing(saved), persistState: true },
      prView({ headRefOid: w.sha }),
      prView({ headRefOid: w.sha }),
    ]);
    // The request still claims a fully cleared candidate. It cannot supply
    // clearance missing from fresh authenticated saved state.
    const reply = merge(w.cfg, request(w));
    assert.equal(reply.merged, false);
    assert.ok("reason" in reply);
    assert.equal(reply.reason, "security");
    assert.deepEqual(writes(), []);
    assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt, null);
    assert.equal(
      sh(`git --git-dir=${w.root}/origin.git rev-parse refs/heads/integration`),
      base,
    );
  });
}
