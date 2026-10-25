// @ts-check
// The code and PR writes of a bound ops request reread ownership first
// (#169), as ops-write-fence.test.mjs's rows do: each is the op's own
// success setup (pr-push.test.mjs), but a successor takes the issue just
// after the request's ownership check. Nothing reaches GitHub and the
// branch on origin doesn't move.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loseOwnership } from "../fake-ownership.mjs";
import { draftMutationReplies } from "../gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
  savedDraftReply,
} from "../initial-write-state-fixtures.mjs";
import { opsFixture } from "../ops-fixtures.mjs";

const fx = await opsFixture("ops-write-fence-push");
fx.fakeGh.requireReplies();
const { ghIsRead } = await import("../../src/github.ts");
const { fakeGh, ask, originRef } = fx;
// What the fresh ownership read before a write says once a successor took
// the issue (coordination-records.ts).
const LOST = /execution ownership lost or unconfirmed/u;
// Each test's issue and its draft PR.
const STARTED = { n: 21, pr: 81 };
/** @type {Record<string, { n: number, pr: number }>} */
const PUSHED = {
  push: { n: 22, pr: 82 },
  "exit-push": { n: 23, pr: 83 },
  "open-pr": { n: 24, pr: 84 },
};

/** @returns {string[][]} */
function writes() {
  return fakeGh.writes(ghIsRead);
}

/** @param {string} out @returns {{ ok: boolean, error?: string }} */
function replyOf(out) {
  return JSON.parse(out);
}

// Queues what start-pr needs to open issue `n`'s draft PR `pr`.
/** @param {number} n @param {number} pr @returns {void} */
function startPrReplies(n, pr) {
  fakeGh.reply([
    initialWriteStateReply(n),
    ...draftMutationReplies(n, pr),
    historyReply(n),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: `repos/o/r/issues/${n}`, stdout: '{"title":"T"}' },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${pr}\n` },
  ]);
}

// Queues what push, exit-push and open-pr need for issue `n`'s draft `pr`.
/** @param {number} n @param {number} pr @returns {void} */
function draftReplies(n, pr) {
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
  ]);
}

test("start-pr: a successor taking the issue before its push and PR create leaves origin and GitHub unchanged", () => {
  const { n, pr } = STARTED;
  startPrReplies(n, pr);
  loseOwnership();
  const refused = replyOf(ask({ op: "start-pr", number: n }));
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), LOST);
  assert.equal(originRef(`agent/issue-${n}`), "");
  assert.deepEqual(writes(), []);
});

for (const op of ["push", "exit-push", "open-pr"]) {
  test(`${op}: a successor taking the issue before the source push leaves origin and GitHub unchanged`, () => {
    const { n, pr } = PUSHED[op] ?? STARTED;
    startPrReplies(n, pr);
    assert.equal(replyOf(ask({ op: "start-pr", number: n })).ok, true);
    const before = originRef(`agent/issue-${n}`);
    fx.commitIn(n, "g", "work");
    draftReplies(n, pr);
    loseOwnership();
    const refused = replyOf(ask({ op, number: n }));
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), LOST);
    assert.equal(originRef(`agent/issue-${n}`), before);
    assert.deepEqual(writes(), []);
  });
}
