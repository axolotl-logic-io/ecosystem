// @ts-check
// Saved authority, not the caller's claimed receipt, guards every merge effect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedOf, current, request } from "./merge-op-test-kit.mjs";
import {
  approvedState,
  fakeGh,
  prView,
  savedListing,
  securityOf,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");

/** @param {import("./ops-publish-test-kit.mjs").World} w @param {string} refusal */
function unclearedState(w, refusal) {
  const saved = approvedState(approvedOf(w));
  const security = {
    ...securityOf(approvedOf(w)),
    candidate: { target: w.cfg.baseBranch, baseSha: "base" },
  };
  saved.security = security;

  switch (refusal) {
    case "missing":
      saved.security = null;
      break;
    case "historical": {
      const { candidate: _candidate, ...historical } = security;
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
      security.candidate.target = "other";
      break;
    case "moved target":
      security.candidate.baseSha = "target-before";
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
    const saved = unclearedState(w, refusal);
    fakeGh.reply([
      savedListing(saved),
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
    assert.equal(saved.mergeAttempt, null);
  });
}
