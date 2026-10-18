// @ts-check
// The author role through a fake RoleContext: a Gherkin reply posts the one
// keyed comment and moves on; an unchanged one returns to the stage the issue
// was sent from; needs-info asks; a failed session stops or defers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { roleOf } from "../src/roles/registry.ts";
import { newIssueState } from "../src/state.ts";
import { testConfig } from "./config-test-kit.mjs";

const { cfg } = testConfig();
const GHERKIN =
  "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed";
const INPUTS = "a".repeat(64);

/**
 * @param {import("../src/job/role-context.ts").SessionResult} result
 * @param {Partial<import("../src/job/role-context.ts").RoleInputs>} [inputs]
 * @param {Partial<import("../src/state.ts").IssueState>} [state]
 */
function fakeContext(result, inputs = {}, state = {}) {
  /** @type {import("../src/job/role-context.ts").SessionSpec[]} */
  const sessions = [];
  /** @type {import("../src/job/role-context.ts").PostedComment[]} */
  const posts = [];
  /** @type {import("../src/job/role-context.ts").RoleContext} */
  const ctx = {
    cfg,
    issue: 7,
    stage: "author",
    state: { ...newIssueState(7), ...state },
    dirs: { job: "/job", repo: "/job/repo", docs: "/job/docs" },
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
      return Promise.resolve(41);
    },
    save: () => Promise.resolve(),
  };
  return { ctx, sessions, posts };
}

const author = roleOf("author");
assert.ok(author !== undefined);
const reply = {
  outcome: "gherkin",
  gherkin: GHERKIN,
  assumptions: [],
  wikiPages: [],
  changed: true,
};

test("an authored Gherkin answers the questions asked before it", async () => {
  const asked = { inputs: "b".repeat(64) };
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
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.key, "gherkin");
  assert.equal(posts[0]?.role, "author");
  assert.ok(posts[0]?.body.includes(`rev=1 inputs=${INPUTS}`));
  assert.equal(end.kind, "next");
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "implement");
  assert.deepEqual(end.state.gherkin, {
    commentId: 41,
    rev: 1,
    inputs: INPUTS,
  });
});

test("an unchanged Gherkin keeps its revision and returns to resumeStage", async () => {
  const gherkin = {
    id: 41,
    rev: 3,
    inputs: "b".repeat(64),
    gherkin: GHERKIN,
    assumptions: [],
    wikiPages: [],
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
  assert.ok(posts[0]?.body.includes(`rev=3 inputs=${INPUTS}`));
});

test("a changed Gherkin goes back to implement from any later stage", async () => {
  const gherkin = {
    id: 41,
    rev: 3,
    inputs: "b".repeat(64),
    gherkin: "Feature: old\n  Scenario: x",
    assumptions: [],
    wikiPages: [],
  };
  const { ctx } = fakeContext(
    { ok: true, reply },
    { gherkin },
    { resumeStage: "merge" },
  );
  const end = await author(ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "implement");
  assert.equal(end.state.gherkin?.rev, 4);
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
    "../src/roles/implementor/implementor.ts"
  );
  const { reviewerRole } = await import("../src/roles/reviewer/reviewer.ts");
  const { mergeRole } = await import("../src/roles/merge/merge.ts");
  assert.equal(roleOf("implement"), implementorRole);
  assert.equal(roleOf("review"), reviewerRole);
  assert.equal(roleOf("merge"), mergeRole);
});
