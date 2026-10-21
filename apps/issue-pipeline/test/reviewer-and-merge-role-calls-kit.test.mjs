// @ts-check
// Check-boundary assertions allow additional reads, but cannot mistake
// premerge or late checks for checks of the merged result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checksBefore } from "./reviewer-and-merge-role-calls-kit.mjs";

const SHA_LENGTH = 40;
const TARGET = {
  number: 7,
  codeMerged: { pr: 90, sha: "e".repeat(SHA_LENGTH) },
};

/** @param {string} name @param {object} [payload] @returns {import("./reviewer-and-merge-role-calls-kit.mjs").Call} */
function op(name, payload = {}) {
  return { kind: "op", name, payload };
}

for (const boundary of /** @type {const} */ (["prepare-review", "finish"])) {
  test(`verify counts with extra reads before ${boundary}`, () => {
    const calls = [
      op("verify", { number: 99 }),
      op("merge"),
      op("current-revision"),
      op("verify", TARGET),
      op("current-revision"),
      op(boundary),
    ];
    assert.deepEqual(checksBefore(calls, boundary), { verify: TARGET });
  });
}

test("checks before merge or after the security boundary do not count", () => {
  const calls = [
    op("verify", TARGET),
    op("merge"),
    op("prepare-review"),
    op("verify", TARGET),
  ];
  assert.deepEqual(checksBefore(calls, "prepare-review"), { verify: {} });
  assert.throws(() => checksBefore(calls, "finish"));
});
