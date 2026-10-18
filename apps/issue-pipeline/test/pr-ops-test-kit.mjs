// @ts-check
// Strict local-origin PR operation fixtures shared by the draft/reopen cases.
import { draftMutationReplies } from "./gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
} from "./initial-write-state-fixtures.mjs";
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("pr-ops");
fx.fakeGh.requireReplies();
const { ghIsRead } = await import("../src/github.ts");
const { fakeGh, ask } = fx;

// The gh calls since the last reply that change GitHub, by src/github.ts's
// own read/write rule.
/** @returns {string[][]} */
function writes() {
  return fakeGh.calls().filter((args) => !ghIsRead(args));
}

const { ISSUE_STATE } = await import("../src/state.ts");
const { stateBody } = await import("../src/saved-state.ts");
const { stateAt } = await import("./job-fixtures.mjs");

/** @param {number} n @param {number} pr @returns {string[]} */
function savedPrCall(n, pr) {
  const state = stateAt("implement", {
    number: n,
    branch: `agent/issue-${n}`,
    lease: null,
    pr,
  });
  return [
    "api",
    "-X",
    "PATCH",
    `repos/o/r/issues/comments/${n}`,
    "-f",
    `body=${stateBody(n, ISSUE_STATE.parse(state))}`,
    "--silent",
  ];
}

/** @param {number} pr @returns {string[]} */
function labelCall(pr) {
  const endpoint = `repos/o/r/issues/${pr}/labels`;
  return ["api", "-X", "POST", endpoint, "--silent", "-f"].concat([
    "labels[]=agent:working",
  ]);
}

/** @param {number} n @param {string[]} flags @param {string} title @param {string} body @returns {string[]} */
function createCall(n, flags, title, body) {
  const head = `agent/issue-${n}`;
  return [
    "pr",
    "create",
    "-R",
    "o/r",
    ...flags,
    "--base",
    "integration",
  ].concat(["--head", head, "--title", title, "--body", body]);
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

export { createCall, fx, labelCall, savedPrCall, startPr, writes };
