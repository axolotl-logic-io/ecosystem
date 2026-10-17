// @ts-check
// start-pr, open-pr and push: their replies, gh writes and branch on origin,
// run through the ops CLI against a local origin and the fake gh.
import assert from "node:assert/strict";
import { test } from "node:test";
import { okLine, opsFixture } from "./ops-fixture.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

const fx = await opsFixture("pr-ops");
const { AUTHOR, signed } = await import("../src/comments.ts");
const { ghIsRead } = await import("../src/github.ts");
const { fakeGh, ask, originRef } = fx;

const DRAFT =
  "Work on this issue has started. This draft PR tracks it; the pipeline replaces this description and marks it ready for review once the change is pushed.";
// Each test's issue, the draft PR start-pr opens for it, and any other PR.
const NEW_BRANCH = { n: 1, pr: 51 };
const PLANNED = { n: 2, pr: 52 };
const LABELLED = { n: 3, pr: 53, open: 77 };
const DRAFTED = { n: 4, pr: 54 };
const NAMED = { n: 5, pr: 55 };
const UNOPENED = { n: 6, pr: 56, opened: 66 };
const NULL_AUTHOR = { n: 9, pr: 59 };
const PUSHED = { n: 7, pr: 57 };
const EMPTY = { n: 8, pr: 58 };
const REOPENED = { n: 11, pr: 61 };
// What a branch with a code change and no wiki reports.
const CODE = { codeChanged: true, wikiAhead: 0 };

// The gh calls since the last reply that change GitHub, by src/github.ts's
// own read/write rule.
/** @returns {string[][]} */
function writes() {
  return fakeGh.calls().filter((args) => !ghIsRead(args));
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

/** @param {number} n @param {string} [tail] @returns {string} */
function draftBody(n, tail = "") {
  return signed({ role: "coordinator" }, `Closes #${n}\n\n${DRAFT}\n${tail}`);
}

// The draft's plan section, folded under a summary.
/** @param {string} plan @returns {string} */
function planDetails(plan) {
  return `<details><summary>Plan</summary>\n\n${plan}\n\n</details>`;
}

// Runs start-pr on a new branch with no open PR, which opens draft `pr`.
/** @param {number} n @param {number} pr @param {object} [extra] @returns {string} */
function startPr(n, pr, extra = {}) {
  fakeGh.reply([
    { when: `repos/o/r/issues/${n}`, stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${pr}\n` },
  ]);
  return ask({ op: "start-pr", number: n, ...extra });
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
    labelCall(pr),
  ]);
});

test("start-pr on an existing branch with an open PR only labels it", () => {
  const { n, pr, open } = LABELLED;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fx.pushFrom(n);
  const before = originRef("agent/issue-3");
  fakeGh.reply([
    { when: "repos/o/r/issues/3", stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: '[{"number":77}]' },
  ]);
  const out = ask({ op: "start-pr", number: 3 });
  assert.equal(out, okLine("start-pr", { pr: open, headSha: before }));
  assert.equal(originRef("agent/issue-3"), before);
  assert.deepEqual(writes(), [labelCall(open)]);
});

/** @param {number} pr @param {string} title @param {string} body @returns {string[][]} */
function editCalls(pr, title, body) {
  return [
    ["pr", "edit", String(pr), "-R", "o/r", "--title", title, "--body", body],
    ["pr", "ready", String(pr), "-R", "o/r"],
  ];
}

test("open-pr fills in the draft and marks it ready", () => {
  const { n, pr } = DRAFTED;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fakeGh.reply([{ when: "pr list", stdout: '[{"number":54}]' }]);
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
  fakeGh.reply([{ when: "pr list", stdout: '[{"number":55}]' }]);
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

test("open-pr opens a ready PR when none is open", () => {
  const { n, pr, opened } = UNOPENED;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fakeGh.reply([
    { when: "pr create", stdout: "https://github.com/o/r/pull/66\n" },
  ]);
  const out = ask({ op: "open-pr", number: 6, title: "", body: "B" });
  const headSha = originRef("agent/issue-6");
  assert.equal(out, okLine("open-pr", { pr: opened, headSha, ...CODE }));
  const body = signed({ role: "implementer" }, "Closes #6\n\nB");
  assert.deepEqual(writes(), [
    createCall(n, [], "Fix #6", body),
    labelCall(opened),
  ]);
});

test("open-pr accepts the null author fields the workflow sends", () => {
  const { n, pr } = NULL_AUTHOR;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fakeGh.reply([{ when: "pr list", stdout: '[{"number":59}]' }]);
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

test("push pushes the branch after a real commit", () => {
  const { n, pr } = PUSHED;
  startPr(n, pr);
  const sha = fx.commitIn(n, "g", "work");
  fakeGh.reply([]);
  const out = ask({ op: "push", number: 7 });
  assert.equal(out, okLine("push", { headSha: sha, ...CODE }));
  assert.equal(originRef("agent/issue-7"), sha);
  assert.deepEqual(pushRecord(fx.root, n), { sha, op: "push", dated: true });
  assert.deepEqual(fakeGh.calls(), []);
});

// A stage job's exit push records itself as "exit-push", which a claim may
// adopt (#315).
test("exit-push pushes the branch and records the push as exit-push", () => {
  const { n } = PUSHED;
  const sha = fx.commitIn(n, "h", "more work");
  fakeGh.reply([]);
  const out = ask({ op: "exit-push", number: 7 });
  assert.equal(out, okLine("exit-push", { headSha: sha, ...CODE }));
  assert.equal(originRef("agent/issue-7"), sha);
  assert.deepEqual(pushRecord(fx.root, n), {
    sha,
    op: "exit-push",
    dated: true,
  });
  assert.deepEqual(fakeGh.calls(), []);
});

test("push with no code change and no wiki commits pushes nothing and says so", () => {
  const { n, pr } = EMPTY;
  startPr(n, pr);
  const before = originRef("agent/issue-8");
  const record = pushRecord(fx.root, n);
  fakeGh.reply([]);
  const out = ask({ op: "push", number: 8 });
  const nothing = { headSha: before, codeChanged: false, wikiAhead: 0 };
  assert.equal(out, okLine("push", nothing));
  assert.equal(originRef("agent/issue-8"), before);
  assert.deepEqual(pushRecord(fx.root, n), record);
});

test("open-pr with reopen reopens the closed PR, fills it in and marks it ready", () => {
  const { n, pr } = REOPENED;
  startPr(n, pr);
  fx.commitIn(n, "g", "work");
  fakeGh.reply([{ when: "pr list", stdout: "[]" }]);
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
    ...editCalls(pr, `T (#${n})`, body),
    labelCall(pr),
  ]);
});
