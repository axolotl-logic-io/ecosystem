// @ts-check
// Strict local-origin PR operation fixtures shared by the draft/reopen cases.
import { draftMutationReplies } from "../gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
} from "../initial-write-state-fixtures.mjs";
import { opsFixture } from "../ops-fixtures.mjs";

const fx = await opsFixture("pr-ops");
fx.fakeGh.requireReplies();
const { ghIsRead } = await import("../../src/github.ts");
const { fakeGh, ask } = fx;

// The gh calls since the last reply that change GitHub, by src/github.ts's
// own read/write rule.
/** @returns {string[][]} */
function writes() {
  return fakeGh.writes(ghIsRead);
}

// Runs start-pr on a new branch with no open PR, which opens draft `pr`.
/** @param {number} n @param {number} pr @param {object} [extra] @returns {string} */
function startPr(n, pr, extra = {}) {
  fakeGh.reply([
    initialWriteStateReply(n),
    ...draftMutationReplies(n, pr),
    historyReply(n),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: `repos/o/r/issues/${n}`, stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${pr}\n` },
  ]);
  return ask({ op: "start-pr", number: n, ...extra });
}

export { fx, startPr, writes };
