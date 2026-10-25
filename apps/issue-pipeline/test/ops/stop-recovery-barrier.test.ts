import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { kit } from "../ops-v2-test-kit.ts";
import { confirmedStop, ISSUE, PR } from "./stop-recovery-test-kit.ts";

const {
  assertStopRecoveryResolved,
}: typeof import("../../src/stop-recovery.ts") = await import(
  "../../src/stop-recovery.ts"
);
const HELD = /unresolved stop recovery.*reconciliation/u;
const EVIDENCE = z.looseObject({
  targets: z.array(z.number()).optional(),
  updates: z.record(z.string(), z.string()),
});

// Stop itself must produce a complete record that the claim barrier accepts.
test("a fully acknowledged real stop clears the local recovery barrier without rewriting evidence", () => {
  const { cfg, file } = confirmedStop();
  const before = fs.readFileSync(file, "utf8");
  const value = EVIDENCE.parse(JSON.parse(before));
  assert.deepEqual(value.targets, [ISSUE, PR]);
  const writes = kit.writes();
  assert.doesNotThrow(() => assertStopRecoveryResolved(cfg, ISSUE));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(kit.writes(), writes);
});

for (const missing of [
  "all",
  "PR group",
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
    } else if (missing === "PR group") {
      for (const key of Object.keys(value.updates)) {
        if (key.endsWith(`:${PR}`)) {
          delete value.updates[key];
        }
      }
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

for (const targets of [undefined, [], [PR], [ISSUE, PR, PR]]) {
  test(`missing or inconsistent stop targets ${JSON.stringify(targets)} require reconciliation`, () => {
    const { cfg, file } = confirmedStop();
    const value = EVIDENCE.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    value.targets = targets;
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
