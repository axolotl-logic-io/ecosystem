// @ts-check
// A stage job whose claim fails (#430) ends finished, and records the claim's
// error as `claimError` in job.json's outcome, for the orchestrator to stop
// the issue on once it repeats: a role stage (triage) and a sweep stage
// (security) alike. A claim that passes records none (job-rate-limit.test.mjs
// pins a passing claim's whole outcome).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  repliesAt,
  runJob,
  SWEEP_STAGE,
  setUp,
  statusOf,
} from "./job-test-kit.mjs";

// The claim op's reply when the claim threw, as the ops CLI reports it.
const ERROR =
  "claim threw: Cannot read properties of undefined (reading 'stage')";
const FAILED_CLAIM = { ok: false, error: ERROR, paths: {} };

/** @param {string} stage */
function claimFails(stage) {
  return setUp({ ...repliesAt(stage), claim: FAILED_CLAIM }, { events: [] });
}

test("a role stage job whose claim fails records the claim's error in job.json's outcome", () => {
  const place = claimFails("triage");
  const r = runJob(place, ["--stage", "triage"]);
  assert.equal(r.status, 0, r.stderr);
  const { kind, claimError } = statusOf(place)?.outcome ?? {};
  assert.deepEqual(
    { kind, claimError },
    { kind: "finished", claimError: ERROR },
  );
});

test("a sweep stage job whose claim fails records the claim's error in job.json's outcome", () => {
  const place = claimFails(SWEEP_STAGE);
  const r = runJob(place, ["--stage", SWEEP_STAGE, "--lane", "L"]);
  assert.equal(r.status, 0, r.stderr);
  const [item] = JSON.parse(r.stdout).items;
  assert.equal(item.outcome, "claim-failed");
  const { kind, claimError } = statusOf(place)?.outcome ?? {};
  assert.deepEqual(
    { kind, claimError },
    { kind: "finished", claimError: ERROR },
  );
});
