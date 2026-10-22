// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { kit } from "../ops-v2-test-kit.mjs";
import { confirmedStop, ISSUE, PR } from "./stop-recovery-test-kit.mjs";

const { assertStopRecoveryResolved } = await import(
  "../../src/stop-recovery.ts"
);
const HELD = /unresolved stop recovery.*reconciliation/u;
const EVIDENCE = z.looseObject({
  updates: z.record(z.string(), z.string()),
});

// Stop itself must produce a complete record that the claim barrier accepts.
test("a fully acknowledged real stop clears the local recovery barrier without rewriting evidence", () => {
  const { cfg, file } = confirmedStop();
  const before = fs.readFileSync(file, "utf8");
  const writes = kit.writes();
  assert.doesNotThrow(() => assertStopRecoveryResolved(cfg, ISSUE));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(kit.writes(), writes);
});

for (const missing of [
  "all",
  "state",
  "lease",
  "claim",
  `explanation:${ISSUE}`,
  `labels:${ISSUE}`,
  `working-label:${ISSUE}`,
  `explanation:${PR}`,
  `labels:${PR}`,
  `working-label:${PR}`,
]) {
  test(`a completed stop with missing ${missing} effects still requires reconciliation`, () => {
    const { cfg, file } = confirmedStop();
    const value = EVIDENCE.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (missing === "all") {
      value.updates = {};
    } else {
      delete value.updates[missing];
    }
    const before = JSON.stringify(value);
    fs.writeFileSync(file, before);
    const writes = kit.writes();
    assert.throws(() => assertStopRecoveryResolved(cfg, ISSUE), HELD);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(kit.writes(), writes);
  });
}

test("malformed local recovery holds with an actionable reconciliation error", () => {
  const { cfg, file } = confirmedStop();
  fs.writeFileSync(file, "{broken");
  assert.throws(() => assertStopRecoveryResolved(cfg, ISSUE), HELD);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});
