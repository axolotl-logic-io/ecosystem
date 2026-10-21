// @ts-check
// start-pr given a body: it sets the body of the branch's open PR, or opens
// the draft with it, and runs twice safely. Without a body it only labels the
// open PR. Checked through the ops CLI's replies and gh writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bodyOf,
  effectNames,
  effectsOf,
  prMutations,
} from "../gh-effects-test-kit.mjs";
import { draftMutationReplies } from "../gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
} from "../initial-write-state-fixtures.mjs";
import { okLine, opsFixture } from "../ops-fixtures.mjs";

const fx = await opsFixture("pr-ops-start-pr");
fx.fakeGh.requireReplies();
const { ghIsRead } = await import("../../src/github.ts");
const { parseStateBody } = await import("../../src/saved-state.ts");
const { fakeGh, ask, originRef } = fx;

// Each test's issue and its PR.
const EDITED = { n: 21, pr: 71 };
const OPENED = { n: 22, pr: 72 };
const TWICE = { n: 23, pr: 73 };
const UNTOUCHED = { n: 24, pr: 74 };

/** @returns {string[][]} */
function writes() {
  return fakeGh.writes(ghIsRead);
}

/** The state mutation's authority facts and labels. @param {number} n */
function savedPr(n) {
  const effects = effectsOf(writes().filter(([command]) => command !== "pr"));
  const saved = parseStateBody(bodyOf(effects, `edit comment ${n} state`), n);
  return {
    effects: effectNames(effects),
    issue: saved?.number,
    branch: saved?.branch,
    pr: saved?.pr,
    stage: saved?.stage,
    lease: saved?.lease,
    codeMerged: saved?.codeMerged,
    merged: saved?.merged,
    security: saved?.security,
  };
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
  assert.partialDeepStrictEqual(prMutations(writes()), [
    { action: "edit", pr: String(pr), repo: "o/r" },
  ]);
  const [mutation] = prMutations(writes());
  assert.ok(mutation?.body?.includes(`Closes #${n}`));
  assert.ok(mutation?.body?.includes("B"));
  assert.deepEqual(savedPr(n), {
    effects: [`edit comment ${n} state`, `label #${pr} agent:working`],
    issue: n,
    branch: `agent/issue-${n}`,
    pr,
    stage: "implement",
    lease: null,
    codeMerged: null,
    merged: null,
    security: null,
  });
});

test("start-pr with a body and no open PR opens a draft with that body only", () => {
  const { n, pr } = OPENED;
  const out = startPr(n, pr, "[]", { body: "B", plan: "P" });
  const headSha = originRef("agent/issue-22");
  assert.equal(out, okLine("start-pr", { pr, headSha }));
  assert.partialDeepStrictEqual(prMutations(writes()), [
    {
      action: "create",
      repo: "o/r",
      draft: true,
      base: "integration",
      head: `agent/issue-${n}`,
      title: "T (#22)",
    },
  ]);
  const [mutation] = prMutations(writes());
  assert.ok(mutation?.body?.includes(`Closes #${n}`));
  assert.ok(mutation?.body?.includes("B"));
  assert.deepEqual(savedPr(n), {
    effects: [`edit comment ${n} state`, `label #${pr} agent:working`],
    issue: n,
    branch: `agent/issue-${n}`,
    pr,
    stage: "implement",
    lease: null,
    codeMerged: null,
    merged: null,
    security: null,
  });
});

test("start-pr with a body run twice opens one draft and sets the same body", () => {
  const { n, pr } = TWICE;
  const first = startPr(n, pr, "[]", { body: "B" });
  const created = prMutations(writes()).filter(
    ({ action }) => action === "create",
  );
  assert.equal(created.length, 1);
  const body = created[0]?.body ?? "";
  const second = startPr(n, pr, `[{"number":${pr}}]`, { body: "B" });
  assert.partialDeepStrictEqual(prMutations(writes()), [
    { action: "edit", pr: String(pr), repo: "o/r", body },
  ]);
  assert.deepEqual(savedPr(n), {
    effects: [`edit comment ${n} state`, `label #${pr} agent:working`],
    issue: n,
    branch: `agent/issue-${n}`,
    pr,
    stage: "implement",
    lease: null,
    codeMerged: null,
    merged: null,
    security: null,
  });
  const headSha = originRef("agent/issue-23");
  assert.equal(first, okLine("start-pr", { pr, headSha }));
  assert.equal(second, first);
});

test("start-pr without a body only labels the open PR", () => {
  const { n, pr } = UNTOUCHED;
  fx.startBranch(n, "initial", "existing branch");
  startPr(n, pr, `[{"number":${pr}}]`, {});
  assert.partialDeepStrictEqual(prMutations(writes()), []);
  assert.deepEqual(savedPr(n), {
    effects: [`edit comment ${n} state`, `label #${pr} agent:working`],
    issue: n,
    branch: `agent/issue-${n}`,
    pr,
    stage: "implement",
    lease: null,
    codeMerged: null,
    merged: null,
    security: null,
  });
});
