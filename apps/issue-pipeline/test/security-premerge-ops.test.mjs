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
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");

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
    const saved = approvedState(approvedOf(w));
    const security = saved.security;
    assert.ok(security?.candidate !== undefined);
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
