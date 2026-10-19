// @ts-check
// Check-boundary assertions allow either check order and additional reads,
// but cannot mistake premerge or late checks for checks of the merged result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checksBefore } from "./reviewer-and-merge-role-calls-kit.mjs";

const SHA_LENGTH = 40;
const TARGET = {
  number: 7,
  codeMerged: { pr: 90, sha: "e".repeat(SHA_LENGTH) },
};
const WIKI_TARGET = { number: 7 };

/** @param {string} name @param {object} [payload] @returns {import("./reviewer-and-merge-role-calls-kit.mjs").Call} */
function op(name, payload = {}) {
  return { kind: "op", name, payload };
}

for (const boundary of /** @type {const} */ ([
  "prepare-review",
  "finish-wiki",
])) {
  for (const first of ["verify", "wiki-check"]) {
    test(`${first} may come first with extra reads before ${boundary}`, () => {
      const checks = [op("verify", TARGET), op("wiki-check", WIKI_TARGET)];
      if (first === "wiki-check") {
        checks.reverse();
      }
      const calls = [
        op("wiki-check", { number: 99 }),
        op("merge"),
        ...checks.flatMap((check) => [op("current-revision"), check]),
        op("current-revision"),
        op(boundary),
      ];
      assert.deepEqual(checksBefore(calls, boundary), {
        verify: TARGET,
        wiki: WIKI_TARGET,
      });
    });
  }
}

test("checks before merge or after the security boundary do not count", () => {
  const calls = [
    op("verify", TARGET),
    op("wiki-check", WIKI_TARGET),
    op("merge"),
    op("prepare-review"),
    op("verify", TARGET),
    op("wiki-check", WIKI_TARGET),
  ];
  assert.deepEqual(checksBefore(calls, "prepare-review"), {
    verify: {},
    wiki: {},
  });
  assert.throws(() => checksBefore(calls, "finish-wiki"));
});
