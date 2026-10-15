// start-pr, open-pr and push: their replies, gh calls and branch on origin,
// run through the ops CLI against a local origin and the fake gh.
import assert from "node:assert/strict";
import { test } from "node:test";
import { okLine, opsFixture, opsSourceDefines } from "./ops-fixture.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

const fx = await opsFixture("pr-ops");
const { signed } = await import("../src/comments.ts");
const { fakeGh, ask, originRef } = fx;

const DRAFT =
  "Work on this issue has started. This draft PR tracks it; the pipeline replaces this description and marks it ready for review once the change is pushed.";
const PLAN_DETAILS = "<details><summary>Plan</summary>\n\nP\n\n</details>";

function issueCall(n) {
  return ["api", `repos/o/r/issues/${n}`];
}

function listCall(n) {
  const head = `agent/issue-${n}`;
  return ["pr", "list", "-R", "o/r", "--head", head, "--state", "open"]
    .concat(["--json", "number"]);
}

function labelCall(pr) {
  const endpoint = `repos/o/r/issues/${pr}/labels`;
  return ["api", "-X", "POST", endpoint, "--silent", "-f"]
    .concat(["labels[]=agent:working"]);
}

function createCall(n, flags, title, body) {
  const head = `agent/issue-${n}`;
  return ["pr", "create", "-R", "o/r", ...flags, "--base", "integration"]
    .concat(["--head", head, "--title", title, "--body", body]);
}

function draftBody(n, tail = "") {
  return signed({ role: "coordinator" }, `Closes #${n}\n\n${DRAFT}\n${tail}`);
}

// Runs start-pr on a new branch with no open PR, which opens draft `pr`.
function startPr(n, pr, extra = {}) {
  fakeGh.reply([
    { when: `repos/o/r/issues/${n}`, stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${pr}\n` },
  ]);
  return ask({ op: "start-pr", number: n, ...extra });
}

test("the PR ops live in src/ops/pr.ts", async () => {
  const { prOps } = await import("../src/ops/pr.ts");
  assert.deepEqual(Object.keys(prOps), ["start-pr", "open-pr", "push"]);
  for (const name of ["start-pr", "open-pr", "push"]) {
    assert.equal(opsSourceDefines(name), false, name);
  }
});

test("start-pr on a new branch with no open PR opens a draft", () => {
  const out = startPr(1, 51);
  const headSha = originRef("agent/issue-1");
  assert.equal(out, okLine("start-pr", { pr: 51, headSha }));
  const record = { sha: headSha, op: "start-pr", dated: true };
  assert.deepEqual(pushRecord(fx.root, 1), record);
  assert.equal(
    fx.sh(`git --git-dir ${fx.root}/origin.git log -1 --format=%B ${headSha}`),
    "Start work on #1\n\nPipeline-Agent: coordinator",
  );
  assert.equal(originRef(`${headSha}^`), originRef("integration"));
  assert.equal(originRef(`${headSha}^{tree}`), originRef("integration^{tree}"));
  assert.deepEqual(fakeGh.calls(), [
    issueCall(1),
    listCall(1),
    createCall(1, ["--draft"], "T (#1)", draftBody(1)),
    labelCall(51),
  ]);
});

test("start-pr with a plan adds it to the draft's body", () => {
  const out = startPr(2, 52, { plan: "P" });
  const headSha = originRef("agent/issue-2");
  assert.equal(out, okLine("start-pr", { pr: 52, headSha }));
  const body = draftBody(2, `\n${PLAN_DETAILS}`);
  assert.ok(body.endsWith(`\n\n${PLAN_DETAILS}`));
  assert.deepEqual(fakeGh.calls()[2], createCall(2, ["--draft"], "T (#2)", body));
});

test("start-pr on an existing branch with an open PR only labels it", () => {
  startPr(3, 53);
  fx.commitIn(3, "g", "work");
  fx.pushFrom(3);
  const before = originRef("agent/issue-3");
  fakeGh.reply([
    { when: "repos/o/r/issues/3", stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: '[{"number":77}]' },
  ]);
  const out = ask({ op: "start-pr", number: 3 });
  assert.equal(out, okLine("start-pr", { pr: 77, headSha: before }));
  assert.equal(originRef("agent/issue-3"), before);
  assert.deepEqual(fakeGh.calls(), [issueCall(3), listCall(3), labelCall(77)]);
});

function editCalls(pr, title, body) {
  return [
    ["pr", "edit", String(pr), "-R", "o/r", "--title", title, "--body", body],
    ["pr", "ready", String(pr), "-R", "o/r"],
  ];
}

test("open-pr fills in the draft and marks it ready", () => {
  startPr(4, 54);
  fx.commitIn(4, "g", "work");
  fakeGh.reply([{ when: "pr list", stdout: '[{"number":54}]' }]);
  const out = ask({ op: "open-pr", number: 4, title: null, body: null });
  const headSha = originRef("agent/issue-4");
  assert.equal(headSha, fx.sh(`git -C ${fx.worktree(4)} rev-parse HEAD`));
  assert.equal(out, okLine("open-pr", { pr: 54, headSha }));
  const record = { sha: headSha, op: "open-pr", dated: true };
  assert.deepEqual(pushRecord(fx.root, 4), record);
  const body = signed({ role: "implementer" }, "Closes #4\n\n");
  assert.deepEqual(fakeGh.calls(), [
    listCall(4),
    // "Fix #4" already names the issue, so it gets no "(#4)".
    ...editCalls(54, "Fix #4", body),
    labelCall(54),
  ]);
});

test("open-pr keeps a title and body that already name the issue", () => {
  startPr(5, 55);
  fx.commitIn(5, "g", "work");
  fakeGh.reply([{ when: "pr list", stdout: '[{"number":55}]' }]);
  const by = { role: "tester", agent: "x" };
  const title = "Fix the #5 bug";
  const text = "Fixes #5 by changing g.";
  const out = ask({ op: "open-pr", number: 5, title, body: text, by });
  const headSha = originRef("agent/issue-5");
  assert.equal(out, okLine("open-pr", { pr: 55, headSha }));
  assert.deepEqual(fakeGh.calls(), [
    listCall(5),
    ...editCalls(55, title, signed(by, text)),
    labelCall(55),
  ]);
});

test("open-pr opens a ready PR when none is open", () => {
  startPr(6, 56);
  fx.commitIn(6, "g", "work");
  fakeGh.reply([
    { when: "pr create", stdout: "https://github.com/o/r/pull/66\n" },
  ]);
  const out = ask({ op: "open-pr", number: 6, title: "", body: "B" });
  const headSha = originRef("agent/issue-6");
  assert.equal(out, okLine("open-pr", { pr: 66, headSha }));
  const body = signed({ role: "implementer" }, "Closes #6\n\nB");
  assert.deepEqual(fakeGh.calls(), [
    listCall(6),
    createCall(6, [], "Fix #6", body),
    labelCall(66),
  ]);
});

test("open-pr accepts the null author fields the workflow sends", () => {
  startPr(9, 59);
  fx.commitIn(9, "g", "work");
  fakeGh.reply([{ when: "pr list", stdout: '[{"number":59}]' }]);
  const by = {
    role: "implementer",
    agent: "issue-pipeline-writer",
    model: null,
    run: null,
  };
  const out = ask({ op: "open-pr", number: 9, title: "T", body: "B", by });
  const headSha = originRef("agent/issue-9");
  assert.equal(out, okLine("open-pr", { pr: 59, headSha }));
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
  assert.equal(signed(by, "Closes #9\n\nB"), body);
  assert.deepEqual(fakeGh.calls(), [
    listCall(9),
    ...editCalls(59, "T (#9)", body),
    labelCall(59),
  ]);
});

test("push pushes the branch after a real commit", () => {
  startPr(7, 57);
  const sha = fx.commitIn(7, "g", "work");
  fakeGh.reply([]);
  const out = ask({ op: "push", number: 7 });
  assert.equal(out, okLine("push", { headSha: sha }));
  assert.equal(originRef("agent/issue-7"), sha);
  assert.deepEqual(pushRecord(fx.root, 7), { sha, op: "push", dated: true });
  assert.deepEqual(fakeGh.calls(), []);
});

test("push refuses a branch with only the empty start commit", () => {
  startPr(8, 58);
  const before = originRef("agent/issue-8");
  fakeGh.reply([]);
  const out = ask({ op: "push", number: 8 });
  const error = "branch changes no files against the base branch";
  assert.equal(out, `${JSON.stringify({ ok: false, error })}\n`);
  assert.equal(originRef("agent/issue-8"), before);
});
