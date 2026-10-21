// @ts-check
// start-pr, open-pr and push: their replies, gh writes and branch on origin,
// run through the ops CLI against a local origin and the fake gh. open-pr
// never marks a PR ready: only ready-pr does (ready-pr-op.test.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { prMutations } from "../gh-effects-test-kit.mjs";
import { draftMutationReplies } from "../gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
  savedDraftReply,
} from "../initial-write-state-fixtures.mjs";
import { okLine } from "../ops-fixtures.mjs";
import { fx, startPr, writes } from "./pr-ops-test-kit.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

const { fakeGh, ask, originRef } = fx;
// Each test's issue, the draft PR start-pr opens for it, and any other PR.
const NEW_BRANCH = { n: 1, pr: 51 };
const PLANNED = { n: 2, pr: 52 };
const DRAFTED = { n: 4, pr: 54 };
const NAMED = { n: 5, pr: 55 };
const UNOPENED = { n: 6, pr: 56, opened: 66 };
const NULL_AUTHOR = { n: 9, pr: 59 };
const REOPENED = { n: 11, pr: 61 };
// What a branch with a code change reports.
const CODE = { codeChanged: true };

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
  assert.partialDeepStrictEqual(prMutations(writes()), [
    {
      action: "create",
      repo: "o/r",
      draft: true,
      base: "integration",
      head: `agent/issue-${n}`,
      title: "T (#1)",
    },
  ]);
  assert.ok(prMutations(writes())[0]?.body?.includes(`Closes #${n}`));
});

test("start-pr with a plan adds it to the draft's body", () => {
  const { n, pr } = PLANNED;
  const out = startPr(n, pr, { plan: "P" });
  const headSha = originRef("agent/issue-2");
  assert.equal(out, okLine("start-pr", { pr, headSha }));

  const [created] = prMutations(writes());
  assert.equal(created?.action, "create");
  assert.equal(created?.draft, true);
  assert.ok(created?.body?.includes(`Closes #${n}`));
  assert.ok(created?.body?.includes("P"));
});

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

  const edited = prMutations(writes());
  assert.equal(edited[0]?.action, "edit");
  assert.equal(edited[0]?.pr, String(pr));
  assert.equal(edited[0]?.title, "Fix #4");
  assert.ok(edited[0]?.body?.includes("Closes #4"));
  assert.equal(
    edited.some(({ action }) => action === "ready"),
    false,
  );
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
  const [edited] = prMutations(writes());
  assert.equal(edited?.pr, String(pr));
  assert.equal(edited?.title, title);
  assert.ok(edited?.body?.includes(text));
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

  const [created] = prMutations(writes());
  assert.equal(created?.action, "create");
  assert.equal(created?.draft, true);
  assert.equal(created?.repo, "o/r");
  assert.equal(created?.base, "integration");
  assert.equal(created?.head, `agent/issue-${n}`);
  assert.equal(created?.title, "Fix #6");
  assert.ok(created?.body?.includes("Closes #6"));
  assert.ok(created?.body?.includes("B"));
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

  const [edited] = prMutations(writes());
  assert.equal(edited?.action, "edit");
  assert.equal(edited?.pr, String(pr));
  assert.ok(edited?.body?.includes("role=implementer"));
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

  const mutations = prMutations(writes());
  assert.ok(
    mutations.some(
      ({ action, pr: number }) => action === "reopen" && number === String(pr),
    ),
  );
  assert.ok(
    mutations.some(
      ({ action, title, body }) =>
        action === "edit" && title === `T (#${n})` && body?.includes("B"),
    ),
  );
  assert.equal(
    mutations.some(({ action }) => action === "ready"),
    false,
  );
});
