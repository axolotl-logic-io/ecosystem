// @ts-check
// A role's op runs in a stage job with the minutes its effect names as its
// timeout (#422), so the finalizer's retest gets verify's and the CI wait's
// time rather than the default ops timeout; an op that names none gets the
// default.
import assert from "node:assert/strict";
import { test } from "node:test";
import { opLaunchOf } from "../src/job/role-launches.ts";
import { opsSpec } from "../src/workflow/launches.ts";

const MINUTE_MS = 60_000;
// verify's minutes, and every op's default.
const VERIFY_MINUTES = 120;
const DEFAULT_MINUTES = 10;
const ISSUE = 7;
const FRAME = { config: "/c.json", sweepId: "s", lane: "l" };

test("an op effect's minutes become its launch's timeout", () => {
  const launch = opLaunchOf(
    ISSUE,
    "verify",
    { testsOnly: true },
    VERIFY_MINUTES,
  );
  assert.equal(launch.minutes, VERIFY_MINUTES);
  assert.deepEqual(launch.payload, { testsOnly: true, number: ISSUE });
  const spec = opsSpec(FRAME, 1, launch, null);
  assert.equal(spec.timeoutMs, VERIFY_MINUTES * MINUTE_MS);
});

test("an op effect with no minutes gets the default ops timeout", () => {
  const launch = opLaunchOf(ISSUE, "merge", {});
  assert.equal("minutes" in launch, false);
  const spec = opsSpec(FRAME, 1, launch, null);
  assert.equal(spec.timeoutMs, DEFAULT_MINUTES * MINUTE_MS);
});
