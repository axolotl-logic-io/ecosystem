// @ts-check
// start-pr given a body: it sets the body of the branch's open PR, or opens
// the draft with it, and runs twice safely. Without a body it only labels the
// open PR. Checked through the ops CLI's replies and gh writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftMutationReplies } from "./gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
} from "./initial-write-state-fixtures.mjs";
import { okLine, opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("pr-ops-start-pr");
fx.fakeGh.requireReplies();
const { signed } = await import("../src/comments.ts");
const { ghIsRead } = await import("../src/github.ts");
const { fakeGh, ask, originRef } = fx;

// Each test's issue and its PR.
const EDITED = { n: 21, pr: 71 };
const OPENED = { n: 22, pr: 72 };
const TWICE = { n: 23, pr: 73 };
const UNTOUCHED = { n: 24, pr: 74 };
const { ISSUE_STATE } = await import("../src/state.ts");
const { stateBody } = await import("../src/saved-state.ts");
const { stateAt } = await import("./job-fixtures.mjs");

/** @returns {string[][]} */
function writes() {
  return fakeGh.calls().filter((args) => !ghIsRead(args));
}

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

/** @param {number} pr @param {string} body @returns {string[]} */
function editCall(pr, body) {
  return ["pr", "edit", String(pr), "-R", "o/r", "--body", body];
}

// The body start-pr gives issue `n`'s PR for the text `text`.
/** @param {number} n @param {string} text @returns {string} */
function prBody(n, text) {
  return signed({ role: "coordinator" }, `Closes #${n}\n\n${text}`);
}

// Runs start-pr for issue `n` while gh lists `listed` as the branch's open
// PRs; a PR it opens is `pr`.
/** @param {number} n @param {number} pr @param {string} listed @param {object} extra @returns {string} */
function startPr(n, pr, listed, extra) {
  fakeGh.reply([
    initialWriteStateReply(n),
    ...draftMutationReplies(n, pr),
    historyReply(
      n,
      JSON.parse(listed).map(
        (/** @type {{number: number}} */ row) => row.number,
      ),
    ),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: `repos/o/r/issues/${n}`, stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: listed },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${pr}\n` },
  ]);
  return ask({ op: "start-pr", number: n, ...extra });
}

test("start-pr with a body sets the open PR's body and leaves it a draft", () => {
  const { n, pr } = EDITED;
  fx.startBranch(n, "initial", "existing branch");
  const out = startPr(n, pr, `[{"number":${pr}}]`, { body: "B" });
  const headSha = originRef("agent/issue-21");
  assert.equal(out, okLine("start-pr", { pr, headSha }));
  assert.deepEqual(writes(), [
    editCall(pr, prBody(n, "B")),
    savedPrCall(n, pr),
    labelCall(pr),
  ]);
});

test("start-pr with a body and no open PR opens a draft with that body only", () => {
  const { n, pr } = OPENED;
  const out = startPr(n, pr, "[]", { body: "B", plan: "P" });
  const headSha = originRef("agent/issue-22");
  assert.equal(out, okLine("start-pr", { pr, headSha }));
  assert.deepEqual(writes(), [
    createCall(n, ["--draft"], "T (#22)", prBody(n, "B")),
    savedPrCall(n, pr),
    labelCall(pr),
  ]);
});

test("start-pr with a body run twice opens one draft and sets the same body", () => {
  const { n, pr } = TWICE;
  const first = startPr(n, pr, "[]", { body: "B" });
  const created = writes().filter((args) => args[1] === "create");
  assert.equal(created.length, 1);
  const body = created[0]?.at(-1) ?? "";
  const second = startPr(n, pr, `[{"number":${pr}}]`, { body: "B" });
  assert.deepEqual(writes(), [
    editCall(pr, body),
    savedPrCall(n, pr),
    labelCall(pr),
  ]);
  const headSha = originRef("agent/issue-23");
  assert.equal(first, okLine("start-pr", { pr, headSha }));
  assert.equal(second, first);
});

test("start-pr without a body only labels the open PR", () => {
  const { n, pr } = UNTOUCHED;
  fx.startBranch(n, "initial", "existing branch");
  startPr(n, pr, `[{"number":${pr}}]`, {});
  assert.deepEqual(writes(), [savedPrCall(n, pr), labelCall(pr)]);
});
