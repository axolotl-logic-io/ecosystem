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

sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

function myClaim(id) {
  return claimComment(id, "me", "s1", LIVE);
}

function coordinator(text) {
  return `**🤖 issue-pipeline · coordinator**\n${STEP_SIGNATURE}\n<!-- agent-pipeline:comment role=coordinator -->\n\n${text}`;
}

test("save-state writes the state it is given, and nothing without one", () => {
  const state = { stage: "plan", pr: null };
  reply([]);
  assert.deepEqual(askOps({ op: "save-state", number: 50, state }), {
    ok: true,
    op: "save-state",
    posted: 0,
  });
  assert.deepEqual(calls(), [
    ghCalls.listComments(50),
    ghCalls.post(50, stateBody(50, state)),
  ]);
  reply([]);
  assert.deepEqual(askOps({ op: "save-state", number: 50 }), {
    ok: true,
    op: "save-state",
    posted: 0,
  });
  assert.deepEqual(calls(), []);
});

test("ask posts numbered questions, parks the issue and closes its claims", () => {
  reply([
    commentsReply(51, [stateComment(5, { stage: "plan" })]),
    commentsReply(51, [myClaim(6)]),
  ]);
  const request = {
    op: "ask",
    number: 51,
    questions: ["Which X?", "Why Y?"],
    state: { stage: "plan", pr: null },
    by: null,
  };
  assert.deepEqual(askOps(request), { ok: true, op: "ask", posted: 0 });
  const questions = `**🤖 issue-pipeline · triage**\n${STEP_SIGNATURE}\n<!-- agent-pipeline:comment role=triage -->\n\nI need answers before the pipeline can work on this issue:\n\n1. Which X?\n2. Why Y?\n\nReply in a comment. A reply from a user on the pipeline's allow list puts the issue back in the queue.`;
  assert.deepEqual(calls(), [
    ghCalls.post(51, questions),
    ghCalls.listComments(51),
    ghCalls.patch(
      5,
      stateBody(51, {
        stage: "triage",
        pr: null,
        questionsAt: TIME,
        lease: null,
      }),
    ),
    ghCalls.unlabel(51, "agent:working"),
    ghCalls.label(51, "agent:needs-info"),
    ghCalls.listComments(51),
    closedClaim(
      6,
      "the pipeline asked questions; an answer puts the issue back in the queue.",
    ),
  ]);
});

// The calls that open split's two sub-issues of #52, the second after the first.
function subIssueCalls() {
  const parent = "\n\n<!-- agent-pipeline:parent 52 depth 2 -->";
  const after = "\nAfter #60 merges.\n<!-- agent-pipeline:after 60 -->";
  function open(title, body, afterLine = "") {
    return [
      "api",
      "-X",
      "POST",
      "repos/o/r/issues",
      "-f",
      `title=${title}`,
      "-f",
      `body=${TRIAGER_SIGNATURE}\n\n${body}\n\nPart of #52.${afterLine}${parent}`,
    ];
  }
  function link(id) {
    return [
      "api",
      "-X",
      "POST",
      "repos/o/r/issues/52/sub_issues",
      "-F",
      `sub_issue_id=${id}`,
      "--silent",
    ];
  }
  return [open("A", "a"), link(900), open("B", "b", after), link(901)];
}

test("split opens ordered sub-issues under the parent and parks it", () => {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-52 ${worktree(52)} origin/integration`,
  );
  reply([
    { when: "title=A", stdout: JSON.stringify({ id: 900, number: 60 }) },
    { when: "title=B", stdout: JSON.stringify({ id: 901, number: 61 }) },
    commentsReply(52, []),
    commentsReply(52, [myClaim(7)]),
  ]);
  const subIssues = [
    { title: "A", body: "a" },
    { title: "B", body: "b", after: [0] },
  ];
  const request = {
    op: "split",
    number: 52,
    state: { stage: "triage", depth: 1 },
    subIssues,
    by: TRIAGER,
  };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "split",
    posted: 0,
    created: [60, 61],
  });
  assert.deepEqual(calls(), [
    ...subIssueCalls(),
    ghCalls.post(
      52,
      `${TRIAGER_SIGNATURE}\n\nI split this issue into #60, #61. The pipeline closes it when they have all merged.`,
    ),
    ghCalls.listComments(52),
    ghCalls.post(
      52,
      stateBody(52, {
        stage: "split",
        depth: 1,
        lease: null,
        subIssues: [60, 61],
      }),
    ),
    ghCalls.unlabel(52, "agent:working"),
    ghCalls.label(52, "agent:split"),
    ghCalls.listComments(52),
    closedClaim(7, "the issue was split into sub-issues."),
  ]);
  assert.equal(fs.existsSync(worktree(52)), false);
});

test("stop by code explains the control on the issue and its PR and swaps labels", () => {
  reply([
    {
      when: "issues/53/labels",
      stdout: JSON.stringify([{ name: "agent:stopped-error" }]),
    },
    commentsReply(53, []),
    commentsReply(53, [myClaim(8)]),
  ]);
  const request = {
    op: "stop",
    number: 53,
    code: "budget",
    reason: "over budget",
    detail: "d",
    nextStep: "next",
    state: { stage: "review", pr: 70 },
  };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    code: "budget",
    label: "agent:stopped-budget",
  });
  const body = coordinator(
    "**🛑 Stopped by a control: token budget** (`agent:stopped-budget`)\n\nThe next session would take the issue past its token budget (`issueTokenBudget`), or a re-check or conflict fix after a rebase past the rebase allowance (`rebaseTokenBudget`).\n\nReason: over budget\n\nd\n\nnext",
  );
  assert.deepEqual(calls(), [
    ghCalls.post(53, body),
    ghCalls.post(70, body),
    ghCalls.listComments(53),
    ghCalls.post(
      53,
      stateBody(53, {
        stage: "stopped",
        pr: 70,
        lease: null,
        stopCode: "budget",
        stopReason: "over budget",
      }),
    ),
    ["api", "repos/o/r/issues/53/labels"],
    ghCalls.unlabel(53, "agent:stopped-error"),
    ghCalls.unlabel(53, "agent:working"),
    ghCalls.label(53, "agent:stopped-budget"),
    ["api", "repos/o/r/issues/70/labels"],
    ghCalls.unlabel(70, "agent:working"),
    ghCalls.label(70, "agent:stopped-budget"),
    ghCalls.listComments(53),
    closedClaim(
      8,
      "the issue stopped (`agent:stopped-budget`); removing the label puts it back in the queue.",
    ),
  ]);
});

test("stop by reason, with no detail, next step or PR, says how to resume", () => {
  reply([]);
  const request = {
    op: "stop",
    number: 54,
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
    ghCalls.post(54, body),
    ghCalls.listComments(54),
    ghCalls.post(
      54,
      stateBody(54, {
        stage: "stopped",
        lease: null,
        stopCode: "push-rejected",
        stopReason: "could not push",
      }),
    ),
    ["api", "repos/o/r/issues/54/labels"],
    ghCalls.unlabel(54, "agent:working"),
    ghCalls.label(54, label),
    ghCalls.listComments(54),
  ]);
});
