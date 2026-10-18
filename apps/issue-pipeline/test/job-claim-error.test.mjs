// @ts-check
// A stage job whose claim fails (#430) ends finished, unclaimed, and records
// the claim's error as `claimError` in its line and in job.json's outcome,
// for the orchestrator to stop the issue on once it repeats: every one of
// the four stages alike, and a claim reply that doesn't parse too. It runs
// no session and saves nothing. A claim that passes records none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTHOR_SESSION, READER_STAGE, repliesAt } from "./job-fixtures.mjs";
import { logOf, runJob, setUp, statusOf } from "./job-test-kit.mjs";

// The claim op's reply when the claim threw, as the ops CLI reports it.
const ERROR =
  "claim threw: Cannot read properties of undefined (reading 'stage')";
const FAILED_CLAIM = { ok: false, error: ERROR, paths: {} };
const STAGES = ["author", "implement", "review", "merge"];
const BAD_CLAIM = /^the claim's reply/u;

/** @param {string} stage @param {unknown} claim */
function claimJob(stage, claim) {
  const place = setUp({ ...repliesAt(stage), claim }, { events: [] });
  const r = runJob(place, ["--stage", stage]);
  if (r.status !== 0) {
    throw new Error(`the job failed: ${r.stderr}`);
  }
  return { place, line: JSON.parse(r.stdout) };
}

for (const stage of STAGES) {
  test(`a ${stage} job whose claim fails records the claim's error in its line and job.json's outcome`, () => {
    const { place, line } = claimJob(stage, FAILED_CLAIM);
    assert.deepEqual(line, {
      issue: 7,
      stage,
      end: "unclaimed",
      reason: ERROR,
      claimError: ERROR,
    });
    const { kind, end, claimError } = statusOf(place)?.outcome ?? {};
    assert.deepEqual(
      { kind, end, claimError },
      { kind: "finished", end: "unclaimed", claimError: ERROR },
    );
    const ops = logOf(place, "ops.log").map(({ op }) => op);
    assert.deepEqual(
      ops.filter((op) => ["save-state", "release", "stop"].includes(op)),
      [],
    );
    assert.deepEqual(logOf(place, "pi.log"), []);
  });
}

test("a won claim whose state doesn't parse records that as the claim's error", () => {
  const won = repliesAt(READER_STAGE).claim;
  const { place, line } = claimJob(READER_STAGE, { ...won, state: {} });
  assert.equal(line.end, "unclaimed");
  assert.match(line.claimError, BAD_CLAIM);
  assert.equal(statusOf(place)?.outcome.claimError, line.claimError);
  assert.deepEqual(logOf(place, "pi.log"), []);
});

test("a claim that passes records no claim error", () => {
  const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const r = runJob(place, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  const line = JSON.parse(r.stdout);
  assert.equal("claimError" in line, false);
  assert.equal("claimError" in (statusOf(place)?.outcome ?? {}), false);
});
