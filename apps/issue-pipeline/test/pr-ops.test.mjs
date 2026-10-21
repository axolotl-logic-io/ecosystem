// @ts-check
// start-pr, open-pr and push: their replies, gh writes and branch on origin,
// run through the ops CLI against a local origin and the fake gh. open-pr
// never marks a PR ready: only ready-pr does (ready-pr-op.test.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftMutationReplies } from "./gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
  savedDraftReply,
} from "./initial-write-state-fixtures.mjs";
import { okLine } from "./ops-fixture.mjs";
import {
  createCall,
  fx,
  labelCall,
  savedPrCall,
  startPr,
  writes,
} from "./pr-ops-test-kit.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

const { fakeGh, ask, originRef } = fx;
const { AUTHOR, signed } = await import("../src/comments.ts");
const DRAFT =
  "Work on this issue has started. This draft PR tracks it; the pipeline replaces this description once the change is pushed, and marks it ready for review once the Reviewer approves it.";
// Each test's issue, the draft PR start-pr opens for it, and any other PR.
const NEW_BRANCH = { n: 1, pr: 51 };
const PLANNED = { n: 2, pr: 52 };
const LABELLED = { n: 3, pr: 53, open: 77 };
const DRAFTED = { n: 4, pr: 54 };
const NAMED = { n: 5, pr: 55 };
const UNOPENED = { n: 6, pr: 56, opened: 66 };
const NULL_AUTHOR = { n: 9, pr: 59 };
const REOPENED = { n: 11, pr: 61 };
// What a branch with a code change reports.
const CODE = { codeChanged: true };

/** @param {number} n @param {string} [tail] @returns {string} */
function draftBody(n, tail = "") {
  return signed({ role: "coordinator" }, `Closes #${n}\n\n${DRAFT}\n${tail}`);
}

// The draft's plan section, folded under a summary.
/** @param {string} plan @returns {string} */
function planDetails(plan) {
  return `<details><summary>Plan</summary>\n\n${plan}\n\n</details>`;
}

test("start-pr on a new branch with no open PR opens a draft", () => {
  const { n, pr } = NEW_BRANCH;
  const out = startPr(n, pr);
  const headSha = originRef("agent/issue-1");
  assert.equal(out, okLine("start-pr", { pr, headSha }));
  const record = { sha: headSha, op: "start-pr", dated: true };
  assert.deepEqual(pushRecord(fx.root, n), record);
  assert.equal(
    fx.sh(`git --git-dir ${fx.root}/origin.git log -1 --format=%B ${headSha}`),
    "Start work on #1\n\nPipeline-Agent: coordinator",
  );
  assert.equal(originRef(`${headSha}^`), originRef("integration"));
  assert.equal(originRef(`${headSha}^{tree}`), originRef("integration^{tree}"));
  assert.deepEqual(writes(), [
    createCall(n, ["--draft"], "T (#1)", draftBody(n)),
    savedPrCall(n, pr),
    labelCall(pr),
  ]);
});

test("start-pr with a plan adds it to the draft's body", () => {
  const { n, pr } = PLANNED;
  const out = startPr(n, pr, { plan: "P" });
  const headSha = originRef("agent/issue-2");
  assert.equal(out, okLine("start-pr", { pr, headSha }));
  const body = draftBody(n, `\n${planDetails("P")}`);
  assert.ok(body.endsWith(`\n\n${planDetails("P")}`));
  assert.deepEqual(writes(), [
    createCall(n, ["--draft"], "T (#2)", body),
    savedPrCall(n, pr),
    labelCall(pr),
  ]);
});

test("start-pr on an existing branch with an open PR only labels it", () => {
  const { n, open } = LABELLED;
  fx.startBranch(n, "g", "work");
  const before = originRef("agent/issue-3");
  fakeGh.reply([
    initialWriteStateReply(n),
    ...draftMutationReplies(n, open),
    historyReply(n, [open]),
    openDraftReply(n, open, `${fx.root}/origin.git`),
    { when: "repos/o/r/issues/3", stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: '[{"number":77}]' },
  ]);
  const out = ask({ op: "start-pr", number: 3 });
  assert.equal(out, okLine("start-pr", { pr: open, headSha: before }));
  assert.equal(originRef("agent/issue-3"), before);
  assert.deepEqual(writes(), [savedPrCall(n, open), labelCall(open)]);
});

/** @param {number} pr @param {string} title @param {string} body @returns {string[][]} */
function editCalls(pr, title, body) {
  return [
    ["pr", "edit", String(pr), "-R", "o/r", "--title", title, "--body", body],
  ];
}

test("open-pr fills in the draft and leaves it a draft", () => {
  const { n, pr } = DRAFTED;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: "pr list", stdout: '[{"number":54}]' },
  ]);
  const out = ask({ op: "open-pr", number: 4, title: null, body: null });
  const headSha = originRef("agent/issue-4");
  assert.equal(headSha, fx.sh(`git -C ${fx.worktree(n)} rev-parse HEAD`));
  assert.equal(out, okLine("open-pr", { pr, headSha, ...CODE }));
  const record = { sha: headSha, op: "open-pr", dated: true };
  assert.deepEqual(pushRecord(fx.root, n), record);
  const body = signed({ role: "implementer" }, "Closes #4\n\n");
  assert.deepEqual(writes(), [
    // "Fix #4" already names the issue, so it gets no "(#4)".
    ...editCalls(pr, "Fix #4", body),
    labelCall(pr),
  ]);
});

test("open-pr keeps a title and body that already name the issue", () => {
  const { n, pr } = NAMED;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: "pr list", stdout: '[{"number":55}]', keep: true },
  ]);
  const by = { role: "tester", agent: "x" };
  const title = "Fix the #5 bug";
  const text = "Fixes #5 by changing g.";
  const out = ask({ op: "open-pr", number: 5, title, body: text, by });
  const headSha = originRef("agent/issue-5");
  assert.equal(out, okLine("open-pr", { pr, headSha, ...CODE }));
  assert.deepEqual(writes(), [
    ...editCalls(pr, title, signed(by, text)),
    labelCall(pr),
  ]);
});

test("open-pr opens a draft PR when none is open", () => {
  const { n, opened } = UNOPENED;
  fx.startBranch(n, "seed-file", "initial branch work");
  fx.commitIn(n, "g", "work");
  fakeGh.reply([
    initialWriteStateReply(n),
    ...draftMutationReplies(n, opened),
    historyReply(n),
    { when: "pr list", stdout: "[]", keep: true },
    { when: "pr create", stdout: "https://github.com/o/r/pull/66\n" },
  ]);
  const out = ask({ op: "open-pr", number: 6, title: "", body: "B" });
  const headSha = originRef("agent/issue-6");
  assert.equal(out, okLine("open-pr", { pr: opened, headSha, ...CODE }));
  const body = signed({ role: "implementer" }, "Closes #6\n\nB");
  assert.deepEqual(writes(), [
    createCall(n, ["--draft"], "Fix #6", body),
    labelCall(opened),
  ]);
});

test("open-pr accepts the null author fields the workflow sends", () => {
  const { n, pr } = NULL_AUTHOR;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: "pr list", stdout: '[{"number":59}]', keep: true },
  ]);
  const by = {
    role: "implementer",
    agent: "issue-pipeline-writer",
    model: null,
    run: null,
  };
  const out = ask({ op: "open-pr", number: 9, title: "T", body: "B", by });
  const headSha = originRef("agent/issue-9");
  assert.equal(out, okLine("open-pr", { pr, headSha, ...CODE }));
  const body = [
    "**🤖 issue-pipeline · implementer**",
    "<sub>agent `issue-pipeline-writer`</sub>",
    "<!-- agent-pipeline:comment role=implementer -->",
    "",
    "Closes #9",
    "",
    "B",
  ].join("\n");
  // The old handler passed `by` to signed() as it came.
  assert.equal(signed(AUTHOR.parse(by), "Closes #9\n\nB"), body);
  assert.deepEqual(writes(), [...editCalls(pr, "T (#9)", body), labelCall(pr)]);
});

test("open-pr with reopen reopens the closed PR and fills it in, never marking it ready", () => {
  const { n, pr } = REOPENED;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  const open = openDraftReply(n, pr, `${fx.root}/origin.git`);
  fakeGh.reply([
    savedDraftReply(n, pr),
    ...draftMutationReplies(n, pr),
    {
      ...open,
      stdout: JSON.stringify({
        ...JSON.parse(open.stdout),
        state: "CLOSED",
      }),
      keep: false,
    },
    open,
    { when: `pr reopen ${pr} -R o/r`, stdout: "" },
    { when: "pr list", stdout: JSON.stringify([{ number: pr }]), keep: true },
  ]);
  const out = ask({
    op: "open-pr",
    number: n,
    title: "T",
    body: "B",
    reopen: pr,
  });
  const headSha = originRef(`agent/issue-${n}`);
  assert.equal(out, okLine("open-pr", { pr, headSha, ...CODE }));
  const body = signed({ role: "implementer" }, `Closes #${n}\n\nB`);
  assert.deepEqual(writes(), [
    ["pr", "reopen", String(pr), "-R", "o/r"],
    savedPrCall(n, pr),
    ...editCalls(pr, `T (#${n})`, body),
    labelCall(pr),
  ]);
});
