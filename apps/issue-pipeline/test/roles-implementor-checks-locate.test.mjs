// @ts-check
// Where the implementor's `checks` entry starts, and what it reads back
// (#420; the wiki's Pipeline-Roles-Implementor, "Locate"): the entry from
// the saved stage, the hand-off fields today's checks stage saves, its CI-fix
// count and continuations from the old fields, and the role's checkpoints
// winning over them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checksLocated, HEAD, PR } from "./implementor-checks-test-kit.mjs";
import { implContext, located } from "./implementor-role-test-kit.mjs";

const STACKED_ON = { issue: 6, headSha: "ccccccc" };
// A CI-fix limit unlike the test config's.
const MAX_CI_FIXES = 3;

/** @param {{ data: object }} position @param {string} field @returns {unknown} the field of the located data */
function fieldIn(position, field) {
  return new Map(Object.entries(position.data)).get(field);
}

test("the saved stage names the entry: checks at checks, implement at implement", () => {
  const checks = checksLocated();
  assert.equal(checks.at, "start");
  assert.equal(checks.data.entry, "checks");
  assert.equal(located().data.entry, "implement");
});

test("locate reads back the hand-off fields today's checks stage saves, and the config's CI-fix limit", () => {
  const at = checksLocated(
    {
      verifiedSha: HEAD,
      verifySummary: "lint: ok",
      testsOnly: true,
      reviewedPatchId: "p0",
      stackedOn: STACKED_ON,
    },
    implContext({ maxCiFixes: MAX_CI_FIXES }),
  );
  assert.equal(fieldIn(at, "verifiedSha"), HEAD);
  assert.equal(fieldIn(at, "verifySummary"), "lint: ok");
  assert.equal(fieldIn(at, "testsOnly"), true);
  assert.equal(fieldIn(at, "reviewedSha"), HEAD);
  assert.equal(fieldIn(at, "reviewedPatchId"), "p0");
  assert.deepEqual(fieldIn(at, "stackedOn"), STACKED_ON);
  assert.equal(fieldIn(at, "headSha"), HEAD);
  assert.deepEqual(fieldIn(at, "flows"), { code: true, wiki: false });
  assert.equal(fieldIn(at, "pr"), PR);
  assert.equal(fieldIn(at, "maxCiFixes"), MAX_CI_FIXES);
});

// testsOnly is read as the fix entry reads it (fix-data.ts), kept missing
// when the state has none; the checks entry runs a missing one as false.
test("a state with no checks fields reads no testsOnly and no fix rounds yet", () => {
  const at = checksLocated();
  assert.equal(fieldIn(at, "testsOnly"), undefined);
  assert.equal(fieldIn(at, "ciFixRounds"), 0);
  assert.equal(fieldIn(at, "ciFixContinuations"), 0);
});

test("today's checks stage's ciFixes and CI-fix continuations carry over", () => {
  const at = checksLocated({
    phase: "ci",
    ciFixes: 1,
    continuations: { implement: 1, ciFix: 1 },
  });
  assert.equal(fieldIn(at, "ciFixRounds"), 1);
  assert.equal(fieldIn(at, "ciFixContinuations"), 1);
  assert.equal(fieldIn(at, "continuations"), 1);
});

test("the role's checkpoints win over today's fields", () => {
  const at = checksLocated({
    ciFixes: 1,
    continuations: { ciFix: 1 },
    checkpoints: { ciFixRounds: 2, ciFixContinuations: 0 },
  });
  assert.equal(fieldIn(at, "ciFixRounds"), 2);
  assert.equal(fieldIn(at, "ciFixContinuations"), 0);
});
