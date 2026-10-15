// @ts-check
// The save-state, ask, split and stop ops through the ops CLI, pinned to the
// replies and gh calls they made before they moved to src/ops/ (#183).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  askOps,
  calls,
  claimComment,
  closedClaim,
  commentsReply,
  ghCalls,
  reply,
  root,
  sh,
  stateBody,
  stateComment,
  TIME,
  worktree,
} from "./ops-cli-test-kit.mjs";

const LIVE = new Date().toISOString();
const TRIAGER = { role: "triage", agent: "triager" };
const TRIAGER_SIGNATURE =
  "**🤖 issue-pipeline · triage**\n<sub>agent `triager`</sub>\n<!-- agent-pipeline:comment role=triage -->";
const STEP_SIGNATURE = "<sub>deterministic step, no model</sub>";
const RESUME_TEXT =
  "The next sweep continues from the PR's branch at review, with every limit reset, the token budget included.";
// Each test's issue, and the comments, PRs and sub-issues it meets.
const SAVED = { n: 50 };
const SAVE_REPLY = { ok: true, op: "save-state", posted: 0 };
const ASKED = { n: 51, state: 5, claim: 6 };
const SPLIT = { n: 52, claim: 7, depth: 1, first: { id: 900, number: 60 }, second: { id: 901, number: 61 } };
const STOPPED = { n: 53, pr: 70, claim: 8 };
const STOPPED_BY_REASON = { n: 54 };

sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

/** @param {number} id @returns {object} */
function myClaim(id) {
  return claimComment(id, "me", "s1", LIVE);
}

/** @param {string} text @returns {string} */
function coordinator(text) {
  return `**🤖 issue-pipeline · coordinator**\n${STEP_SIGNATURE}\n<!-- agent-pipeline:comment role=coordinator -->\n\n${text}`;
}

// Joins a comment's paragraphs.
/** @param {readonly string[]} texts @returns {string} */
function paragraphs(texts) {
  return texts.join("\n\n");
}

// A config setting named in a stop's explanation, as src/stops.ts names it.
/** @param {string} setting @returns {string} */
function settingRef(setting) {
  return `(\`${setting}\`)`;
}

test("save-state writes the state it is given, and nothing without one", () => {
  const { n } = SAVED;
  const state = { stage: "plan", pr: null };
  reply([]);
  assert.deepEqual(askOps({ op: "save-state", number: n, state }), SAVE_REPLY);
  assert.deepEqual(calls(), [
    ghCalls.listComments(n),
    ghCalls.post(n, stateBody(n, state)),
  ]);
  reply([]);
  assert.deepEqual(askOps({ op: "save-state", number: n }), SAVE_REPLY);
  assert.deepEqual(calls(), []);
});

test("ask posts numbered questions, parks the issue and closes its claims", () => {
  const { n, state, claim } = ASKED;
  reply([
    commentsReply(n, [stateComment(state, { stage: "plan" })]),
    commentsReply(n, [myClaim(claim)]),
  ]);
  const request = {
    op: "ask",
    number: n,
    questions: ["Which X?", "Why Y?"],
    state: { stage: "plan", pr: null },
    by: null,
  };
  assert.deepEqual(askOps(request), { ok: true, op: "ask", posted: 0 });
  const questions = `**🤖 issue-pipeline · triage**\n${STEP_SIGNATURE}\n<!-- agent-pipeline:comment role=triage -->\n\nI need answers before the pipeline can work on this issue:\n\n1. Which X?\n2. Why Y?\n\nReply in a comment. A reply from a user on the pipeline's allow list puts the issue back in the queue.`;
  assert.deepEqual(calls(), [
    ghCalls.post(n, questions),
    ghCalls.listComments(n),
    ghCalls.patch(
      state,
      stateBody(n, {
        stage: "triage",
        pr: null,
        questionsAt: TIME,
        lease: null,
      }),
    ),
    ghCalls.unlabel(n, "agent:working"),
    ghCalls.label(n, "agent:needs-info"),
    ghCalls.listComments(n),
    closedClaim(
      claim,
      "the pipeline asked questions; an answer puts the issue back in the queue.",
    ),
  ]);
});

// The gh call that opens one of split's sub-issues of SPLIT.
/** @param {string} title @param {string} body @param {string} [afterLine] @returns {string[]} */
function openCall(title, body, afterLine = "") {
  const parent = `\n\n<!-- agent-pipeline:parent ${SPLIT.n} depth 2 -->`;
  const text = `${TRIAGER_SIGNATURE}\n\n${body}\n\nPart of #${SPLIT.n}.${afterLine}${parent}`;
  return ["api", "-X", "POST", "repos/o/r/issues", "-f", `title=${title}`, "-f", `body=${text}`];
}

// The gh call that links a sub-issue to SPLIT.
/** @param {number} id @returns {string[]} */
function linkCall(id) {
  const endpoint = `repos/o/r/issues/${SPLIT.n}/sub_issues`;
  return ["api", "-X", "POST", endpoint, "-F", `sub_issue_id=${id}`, "--silent"];
}

// The calls that open split's two sub-issues of SPLIT, the second after the first.
/** @returns {string[][]} */
function subIssueCalls() {
  const { first, second } = SPLIT;
  const after = `\nAfter #${first.number} merges.\n<!-- agent-pipeline:after ${first.number} -->`;
  return [openCall("A", "a"), linkCall(first.id), openCall("B", "b", after), linkCall(second.id)];
}

// Every gh call split makes for SPLIT, after it opens the sub-issues.
/** @returns {string[][]} */
function splitCalls() {
  const { n, claim, depth, first, second } = SPLIT;
  const created = `#${first.number}, #${second.number}`;
  const note = `I split this issue into ${created}. The pipeline closes it when they have all merged.`;
  const subIssues = [first.number, second.number];
  return [
    ...subIssueCalls(),
    ghCalls.post(n, `${TRIAGER_SIGNATURE}\n\n${note}`),
    ghCalls.listComments(n),
    ghCalls.post(n, stateBody(n, { stage: "split", depth, lease: null, subIssues })),
    ghCalls.unlabel(n, "agent:working"),
    ghCalls.label(n, "agent:split"),
    ghCalls.listComments(n),
    closedClaim(claim, "the issue was split into sub-issues."),
  ];
}

test("split opens ordered sub-issues under the parent and parks it", () => {
  const { n, claim, depth, first, second } = SPLIT;
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${n} ${worktree(n)} origin/integration`,
  );
  reply([
    { when: "title=A", stdout: JSON.stringify(first) },
    { when: "title=B", stdout: JSON.stringify(second) },
    commentsReply(n, []),
    commentsReply(n, [myClaim(claim)]),
  ]);
  const subIssues = [
    { title: "A", body: "a" },
    { title: "B", body: "b", after: [0] },
  ];
  const request = {
    op: "split",
    number: n,
    state: { stage: "triage", depth },
    subIssues,
    by: TRIAGER,
  };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "split",
    posted: 0,
    created: [first.number, second.number],
  });
  assert.deepEqual(calls(), splitCalls());
  assert.equal(fs.existsSync(worktree(n)), false);
});

// The comment stop posts for STOPPED, on the issue and its PR.
/** @returns {string} */
function budgetStopBody() {
  return coordinator(
    paragraphs([
      "**🛑 Stopped by a control: token budget** (`agent:stopped-budget`)",
      `The next session would take the issue past its token budget ${settingRef("issueTokenBudget")}, or a re-check or conflict fix after a rebase past the rebase allowance ${settingRef("rebaseTokenBudget")}.`,
      "Reason: over budget",
      "d",
      "next",
    ]),
  );
}

// Every gh call stop makes for STOPPED.
/** @returns {string[][]} */
function budgetStopCalls() {
  const { n, pr, claim } = STOPPED;
  const body = budgetStopBody();
  const stopState = { stage: "stopped", pr, lease: null, stopCode: "budget", stopReason: "over budget" };
  return [
    ghCalls.post(n, body),
    ghCalls.post(pr, body),
    ghCalls.listComments(n),
    ghCalls.post(n, stateBody(n, stopState)),
    ["api", `repos/o/r/issues/${n}/labels`],
    ghCalls.unlabel(n, "agent:stopped-error"),
    ghCalls.unlabel(n, "agent:working"),
    ghCalls.label(n, "agent:stopped-budget"),
    ["api", `repos/o/r/issues/${pr}/labels`],
    ghCalls.unlabel(pr, "agent:working"),
    ghCalls.label(pr, "agent:stopped-budget"),
    ghCalls.listComments(n),
    closedClaim(
      claim,
      "the issue stopped (`agent:stopped-budget`); removing the label puts it back in the queue.",
    ),
  ];
}

test("stop by code explains the control on the issue and its PR and swaps labels", () => {
  const { n, pr, claim } = STOPPED;
  reply([
    {
      when: `issues/${n}/labels`,
      stdout: JSON.stringify([{ name: "agent:stopped-error" }]),
    },
    commentsReply(n, []),
    commentsReply(n, [myClaim(claim)]),
  ]);
  const request = {
    op: "stop",
    number: n,
    code: "budget",
    reason: "over budget",
    detail: "d",
    nextStep: "next",
    state: { stage: "review", pr },
  };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    code: "budget",
    label: "agent:stopped-budget",
  });
  assert.deepEqual(calls(), budgetStopCalls());
});

test("stop by reason, with no detail, next step or PR, says how to resume", () => {
  const { n } = STOPPED_BY_REASON;
  reply([]);
  const request = {
    op: "stop",
    number: n,
    code: null,
    reason: "could not push",
    detail: "",
    nextStep: null,
    state: { stage: "implement" },
  };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    code: "push-rejected",
    label: "agent:stopped-push-rejected",
  });
  const label = "agent:stopped-push-rejected";
  const body = coordinator(
    `**🛑 Stopped by a control: push** (\`${label}\`)\n\nGitHub rejected a push of the PR branch.\n\nReason: could not push\n\n\nTo resume, fix what this names (push to the branch if you like), then remove \`${label}\`. ${RESUME_TEXT}`,
  );
  assert.deepEqual(calls(), [
    ghCalls.post(n, body),
    ghCalls.listComments(n),
    ghCalls.post(
      n,
      stateBody(n, {
        stage: "stopped",
        lease: null,
        stopCode: "push-rejected",
        stopReason: "could not push",
      }),
    ),
    ["api", `repos/o/r/issues/${n}/labels`],
    ghCalls.unlabel(n, "agent:working"),
    ghCalls.label(n, label),
    ghCalls.listComments(n),
  ]);
});
