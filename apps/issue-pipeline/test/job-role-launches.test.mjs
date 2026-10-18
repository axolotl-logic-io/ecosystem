// @ts-check
// A role's op effect as a stage job launches it (#420): it names the issue,
// and an op that asks for more minutes, such as verify or the CI wait, gets
// them instead of the ops default.
import assert from "node:assert/strict";
import { test } from "node:test";
import { opLaunchOf } from "../src/job/role-launches.ts";
import { opsSpec } from "../src/workflow/launches.ts";

const FRAME = { config: "/w/repos/o__r.json", sweepId: "s1", lane: "job" };
const MINUTE_MS = 60_000;
const VERIFY_MINUTES = 120;
const ISSUE = 7;
// A number the payload gives that the launch replaces with the issue's.
const OTHER = 3;

test("a role's op names the issue, and one given minutes runs that long", () => {
  const plain = opLaunchOf(ISSUE, "push", { number: OTHER });
  assert.deepEqual(plain.payload, { number: ISSUE });
  const verify = opLaunchOf(
    ISSUE,
    "verify",
    { testsOnly: false },
    VERIFY_MINUTES,
  );
  const spec = opsSpec(FRAME, 1, verify, null);
  assert.equal(spec.timeoutMs, VERIFY_MINUTES * MINUTE_MS);
  assert.ok(opsSpec(FRAME, 1, plain, null).timeoutMs < spec.timeoutMs);
});
