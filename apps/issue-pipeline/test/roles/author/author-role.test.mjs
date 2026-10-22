// @ts-check
// The author role through a fake RoleContext: a Gherkin reply posts the one
// keyed comment and moves on; an unchanged one returns to the stage the issue
// was sent from; needs-info asks; a failed session stops or defers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubComment } from "../../fake-gh.mjs";
import "../../isolated-root-test-kit.mjs";

const { testConfig } = await import("../../config-test-kit.mjs");
const { authorRole: author } = await import(
  "../../../src/roles/author/author.ts"
);
const { COMMENT, signed, keyMark } = await import("../../../src/comments.ts");
const { gherkinCommentOf } = await import("../../../src/gherkin-comment.ts");
const { roleOf } = await import("../../../src/roles/registry.ts");
const { newIssueState } = await import("../../../src/state.ts");

const { cfg } = testConfig();
const GHERKIN =
  "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed";
// A trusted-inputs revision is a sha-256 in hex.
const INPUTS_LENGTH = 64;
const INPUTS = "a".repeat(INPUTS_LENGTH);
const EARLIER_INPUTS = "b".repeat(INPUTS_LENGTH);
const ISSUE = 7;
// The id ctx.post gives the Gherkin comment.
const GHERKIN_COMMENT = 41;
// The revision of an earlier Gherkin, and the one a change makes from it.
const EARLIER_REV = 3;
const CHANGED_REV = 4;

/**
 * @param {import("../../../src/job/role-context.ts").SessionResult} result
 * @param {Partial<import("../../../src/job/role-context.ts").RoleInputs>} [inputs]
 * @param {Partial<import("../../../src/state.ts").IssueState>} [state]
 */
function fakeContext(result, inputs = {}, state = {}) {
  /** @type {import("../../../src/job/role-context.ts").SessionSpec[]} */
  const sessions = [];
  /** @type {import("../../../src/job/role-context.ts").PostedComment[]} */
  const posts = [];
  /** @type {import("../../../src/job/role-context.ts").RoleContext} */
  const ctx = {
    cfg,
    issue: ISSUE,
    stage: "author",
    state: { ...newIssueState(ISSUE, "author"), ...state },
    dirs: { job: "/job", repo: "/job/repo" },
    issueFile: "/run/issue.md",
    mergeQueue: null,
    inputs: {
      issue: { title: "T", body: "B", user: { login: "owner" } },
      comments: [],
      revision: INPUTS,
      gherkin: null,
      ...inputs,
    },
    op: () => Promise.reject(new Error("the author runs no op")),
    session: (spec) => {
      sessions.push(spec);
      return Promise.resolve(result);
    },
    post: (comment) => {
      posts.push(comment);
      return Promise.resolve(GHERKIN_COMMENT);
    },
    save: () => Promise.resolve(),
  };
  return { ctx, sessions, posts };
}

/** @param {import("../../../src/job/role-context.ts").PostedComment | undefined} post */
function parsedPost(post) {
  if (post === undefined) {
    throw new Error("author posted no Gherkin");
  }
  return gherkinCommentOf(cfg, ISSUE, [
    COMMENT.parse(
      githubComment({
        id: GHERKIN_COMMENT,
        created: "2026-10-19T00:00:00Z",
        login: cfg.mergeAccount,
        body: `${signed({ role: post.role }, post.body)}\n${keyMark(ISSUE, post.key ?? "")}`,
      }),
    ),
  ]);
}

const reply = {
  outcome: "gherkin",
  gherkin: GHERKIN,
  assumptions: [],
  changed: true,
};

const AUTHORING_TASK = /Task: `authoring`/u;
// Behaviour is the prompt page's, never the task's.
const BEHAVIOUR_WORDS = /AGENTS\.md|artificial load|allow-listed/iu;

test("an authored Gherkin answers the questions asked before it", async () => {
  const asked = { inputs: EARLIER_INPUTS };
  const { ctx } = fakeContext({ ok: true, reply }, {}, { asked });
  const end = await author(ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.asked, null);
});

test("a first Gherkin posts revision 1 and goes to implement", async () => {
  const { ctx, sessions, posts } = fakeContext({ ok: true, reply });
  const end = await author(ctx);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.agent, "issue-pipeline-author");
  assert.equal(sessions[0]?.commits, false);
  assert.equal(sessions[0]?.model, cfg.models.author);
  const task = sessions[0]?.task ?? "";
  assert.match(task, AUTHORING_TASK);
  assert.doesNotMatch(task, BEHAVIOUR_WORDS);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.key, "gherkin");
  assert.equal(posts[0]?.role, "author");
  assert.equal(parsedPost(posts[0])?.rev, 1);
  assert.equal(parsedPost(posts[0])?.inputs, INPUTS);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "implement");
  assert.deepEqual(end.state.gherkin, {
    commentId: GHERKIN_COMMENT,
    rev: 1,
    inputs: INPUTS,
  });
});

test("an unchanged Gherkin keeps its revision and returns to resumeStage", async () => {
  const gherkin = {
    id: GHERKIN_COMMENT,
    rev: EARLIER_REV,
    inputs: EARLIER_INPUTS,
    gherkin: GHERKIN,
    assumptions: [],
  };
  const { ctx, posts } = fakeContext(
    { ok: true, reply: { ...reply, changed: false } },
    { gherkin },
    { resumeStage: "review" },
  );
  const end = await author(ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.resumeStage, null);
  assert.equal(parsedPost(posts[0])?.rev, EARLIER_REV);
  assert.equal(parsedPost(posts[0])?.inputs, INPUTS);
});

test("a changed Gherkin goes back to implement from any later stage", async () => {
  const gherkin = {
    id: GHERKIN_COMMENT,
    rev: EARLIER_REV,
    inputs: EARLIER_INPUTS,
    gherkin: "Feature: old\n  Scenario: x",
    assumptions: [],
  };
  const { ctx } = fakeContext(
    { ok: true, reply },
    { gherkin },
    { resumeStage: "merge" },
  );
  const end = await author(ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "implement");
  assert.equal(end.state.gherkin?.rev, CHANGED_REV);
});

test("needs-info asks and stays at author, posting no Gherkin", async () => {
  const { ctx, posts } = fakeContext({
    ok: true,
    reply: { outcome: "needs-info", questions: ["Which panel?"] },
  });
  const end = await author(ctx);
  assert.ok(end.kind === "ask");
  assert.deepEqual(end.questions, ["Which panel?"]);
  assert.equal(end.state.stage, "author");
  assert.equal(posts.length, 0);
});

test("a failed session stops with error, and a transient one defers", async () => {
  const failed = await author(
    fakeContext({ ok: false, transient: false, error: "bad reply" }).ctx,
  );
  assert.equal(failed.kind, "stop");
  assert.ok(failed.kind === "stop" && failed.code === "error");
  const deferred = await author(
    fakeContext({ ok: false, transient: true, error: "429" }).ctx,
  );
  assert.equal(deferred.kind, "deferred");
});

test("every stage runs its own role", async () => {
  const { implementorRole } = await import(
    "../../../src/roles/implementor/implementor.ts"
  );
  const { reviewerRole } = await import(
    "../../../src/roles/reviewer/reviewer.ts"
  );
  const { mergeRole } = await import("../../../src/roles/merge/merge.ts");
  assert.equal(roleOf("author"), author);
  assert.equal(roleOf("implement"), implementorRole);
  assert.equal(roleOf("review"), reviewerRole);
  assert.equal(roleOf("merge"), mergeRole);
});
