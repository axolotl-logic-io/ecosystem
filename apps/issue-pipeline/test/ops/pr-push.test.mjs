// @ts-check
// Existing deterministic push controls, with truthful saved draft authority.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftMutationReplies } from "../gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
  savedDraftReply,
} from "../initial-write-state-fixtures.mjs";
import { okLine, opsFixture } from "../ops-fixtures.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

const fx = await opsFixture("pr-push");
fx.fakeGh.requireReplies();
const { ghIsRead } = await import("../../src/github.ts");
const { fakeGh, ask, originRef } = fx;
const PUSHED = { n: 7, pr: 57 };
const EMPTY = { n: 8, pr: 58 };
const CODE = { codeChanged: true };
/** @returns {string[][]} */
function writes() {
  return fakeGh.writes(ghIsRead);
}
/** @param {number} n @param {number} pr @returns {string} */
function startPr(n, pr) {
  fakeGh.reply([
    initialWriteStateReply(n),
    ...draftMutationReplies(n, pr),
    historyReply(n),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: `repos/o/r/issues/${n}`, stdout: '{"title":"T"}' },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${pr}\n` },
  ]);
  return ask({ op: "start-pr", number: n });
}
test("push pushes the branch after a real commit", () => {
  const { n, pr } = PUSHED;
  startPr(n, pr);
  const sha = fx.commitIn(n, "g", "work");
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
  ]);
  const out = ask({ op: "push", number: 7 });
  assert.equal(out, okLine("push", { headSha: sha, ...CODE }));
  assert.equal(originRef("agent/issue-7"), sha);
  assert.deepEqual(pushRecord(fx.root, n), { sha, op: "push", dated: true });
  assert.deepEqual(writes(), []);
});

// A stage job's exit push records itself as "exit-push", which a claim may
// adopt (#315).
test("exit-push pushes the branch and records the push as exit-push", () => {
  const { n, pr } = PUSHED;
  const sha = fx.commitIn(n, "h", "more work");
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
  ]);
  const out = ask({ op: "exit-push", number: 7 });
  assert.equal(out, okLine("exit-push", { headSha: sha, ...CODE }));
  assert.equal(originRef("agent/issue-7"), sha);
  assert.deepEqual(pushRecord(fx.root, n), {
    sha,
    op: "exit-push",
    dated: true,
  });
  assert.deepEqual(writes(), []);
});

test("push with no code change pushes nothing and says so", () => {
  const { n, pr } = EMPTY;
  startPr(n, pr);
  const before = originRef("agent/issue-8");
  const record = pushRecord(fx.root, n);
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
  ]);
  const out = ask({ op: "push", number: 8 });
  const nothing = { headSha: before, codeChanged: false };
  assert.equal(out, okLine("push", nothing));
  assert.equal(originRef("agent/issue-8"), before);
  assert.deepEqual(pushRecord(fx.root, n), record);
});
