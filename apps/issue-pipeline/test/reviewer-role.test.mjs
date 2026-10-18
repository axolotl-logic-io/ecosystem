// @ts-check
// The reviewer role through a fake RoleContext: one read-only session per
// round, a verdict bound to the exact revision read before and after it, a
// security finding that stops whatever the verdict, numbered findings, the
// fix-round bound, and the wiki-only review after the code merged.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvedReview,
  cfg,
  current,
  fakeContext,
  GHERKIN_TEXT,
  gherkinComment,
  HEAD,
  INPUTS,
  issueState,
  MERGE_COMMIT,
  opNames,
  opPayloads,
  PR,
  postsOf,
  REVISION,
  reviewerRole,
  sessionsOf,
  stateOf,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";

const PREPARED = {
  headSha: HEAD,
  diffPath: "/run/review-r1/diff.patch",
  bundlePath: "/run/review-r1/bundle.md",
  changedFiles: ["src/chat.ts", "wiki/Chats.md"],
};
const MOVED = "f".repeat(40);

/**
 * @param {Partial<import("../src/roles/replies.ts").ReviewerReply>} [reply]
 * @returns {import("../src/job/role-context.ts").SessionResult}
 */
function verdict(reply = {}) {
  return {
    ok: true,
    reply: {
      verdict: "approve",
      summary: "Does what the Gherkin says.",
      findings: [],
      security: null,
      ...reply,
    },
  };
}

/**
 * @param {{
 *   state?: Partial<import("../src/state.ts").IssueState>,
 *   before?: unknown, after?: unknown, prepared?: unknown,
 *   result?: import("../src/job/role-context.ts").SessionResult,
 *   gherkin?: ReturnType<typeof gherkinComment> | null,
 * }} [script]
 */
function review(script = {}) {
  return fakeContext({
    stage: "review",
    state: issueState({ stage: "review", verifiedSha: HEAD, ...script.state }),
    gherkin: script.gherkin,
    ops: {
      "current-revision": [script.before ?? current(), script.after ?? current()],
      "prepare-review": [script.prepared ?? PREPARED],
    },
    sessions: [script.result ?? verdict()],
  });
}

const blocking = {
  severity: /** @type {const} */ ("blocking"),
  text: "The list isn't sorted.",
  path: "src/chat.ts",
  line: 12,
};

test("an approval runs one reviewer session and binds the revision it saw", async () => {
  const { ctx, calls } = review();
  const state = stateOf(await reviewerRole(ctx), "next");
  const sessions = sessionsOf(calls);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.agent, "issue-pipeline-reviewer");
  assert.equal(sessions[0]?.model, cfg.models.reviewer);
  assert.equal(sessions[0]?.commits, false);
  const task = sessions[0]?.task ?? "";
  for (const part of [
    GHERKIN_TEXT,
    PREPARED.bundlePath,
    "AGENTS.md",
    "user-harm",
    "rights",
    "financial-harm",
    "abuse-risk",
    "the list is newest first",
  ]) {
    assert.ok(task.includes(part), `the task lacks ${part}`);
  }
  assert.deepEqual(opNames(calls), [
    "current-revision",
    "prepare-review",
    "current-revision",
  ]);
  const sessionAt = calls.findIndex((call) => call.kind === "session");
  const lastRead = calls.findLastIndex(
    (call) => call.kind === "op" && call.name === "current-revision",
  );
  assert.ok(lastRead > sessionAt, "the revision is read again after the session");
  assert.equal(state.stage, "merge");
  assert.equal(state.review.verdict, "approve");
  assert.deepEqual(state.review.revision, REVISION);
  assert.equal(state.review.commentId, 51);
  const posts = postsOf(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.key, "review");
  assert.equal(posts[0]?.on, "pr");
  assert.equal(posts[0]?.role, "reviewer");
  assert.ok(posts[0]?.body.includes(HEAD.slice(0, 12)));
});

test("a security finding stops with its category even when the verdict approves", async () => {
  const { ctx, calls } = review({
    result: verdict({
      security: { category: "rights", reason: "It shares chats publicly." },
    }),
    after: current({ code: MOVED }),
  });
  const end = await reviewerRole(ctx);
  const state = stateOf(end, "stop");
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "rights");
  assert.ok(end.reason.includes("It shares chats publicly."));
  assert.equal(state.review.verdict, null);
  assert.equal(state.stage, "review");
  assert.equal(postsOf(calls).length, 0);
});

test("changes number the findings on from the last round's and go back to implement", async () => {
  const previous = [1, 2, 3].map((id) => ({
    id,
    severity: /** @type {const} */ ("blocking"),
    text: `old ${id}`,
  }));
  const { ctx, calls } = review({
    state: { review: { ...approvedReview(), verdict: "changes", round: 1, findings: previous } },
    result: verdict({
      verdict: "changes",
      findings: [blocking, { severity: "note", text: "A name could be clearer." }],
    }),
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.equal(state.review.round, 2);
  assert.equal(state.review.verdict, "changes");
  assert.deepEqual(
    state.review.findings.map((finding) => finding.id),
    [4, 5],
  );
  assert.ok(sessionsOf(calls)[0]?.task.includes("#3 [blocking] old 3"));
  assert.ok(postsOf(calls)[0]?.body.includes("#4 [blocking] (src/chat.ts:12)"));
});

test("an approval with a blocking finding counts as changes", async () => {
  const { ctx } = review({ result: verdict({ findings: [blocking] }) });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.equal(state.review.verdict, "changes");
});

test("changes are allowed for exactly maxFixRounds rounds, then stop", async () => {
  assert.equal(cfg.maxFixRounds, 2);
  const last = review({
    state: { review: { ...approvedReview(), verdict: "changes", round: 1 } },
    result: verdict({ verdict: "changes", findings: [blocking] }),
  });
  assert.equal(stateOf(await reviewerRole(last.ctx), "next").review.round, 2);
  const past = review({
    state: { review: { ...approvedReview(), verdict: "changes", round: 2 } },
    result: verdict({ verdict: "changes", findings: [blocking] }),
  });
  const end = await reviewerRole(past.ctx);
  stateOf(end, "stop");
  assert.ok(end.kind === "stop" && end.code === "review-rounds");
});

test("a head that moved during the session discards the verdict", async () => {
  const { ctx, calls } = review({
    state: { review: approvedReview() },
    after: current({ wiki: MOVED }),
  });
  const state = stateOf(await reviewerRole(ctx), "wait");
  assert.equal(state.review.verdict, null);
  assert.equal(postsOf(calls).length, 0);
});

test("inputs that changed during the session send the issue to the author", async () => {
  const { ctx, calls } = review({ after: current({ inputs: "9".repeat(64) }) });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.equal(postsOf(calls).length, 0);
});

test("a Gherkin older than the inputs goes to the author before any review", async () => {
  const { ctx, calls } = review({ gherkin: gherkinComment({ inputs: "8".repeat(64) }) });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(sessionsOf(calls).length, 0);
});

test("a diff prepared at another head than the revision is not reviewed", async () => {
  const { ctx, calls } = review({ prepared: { ...PREPARED, headSha: MOVED } });
  stateOf(await reviewerRole(ctx), "wait");
  assert.equal(sessionsOf(calls).length, 0);
});

test("after the code merged, the wiki-only review binds the merge commit", async () => {
  const merged = current({ code: MERGE_COMMIT }, { number: PR, state: "MERGED", mergeCommit: MERGE_COMMIT });
  const { ctx, calls } = review({
    state: { codeMerged: { pr: PR, sha: MERGE_COMMIT }, verifiedSha: MERGE_COMMIT },
    before: merged,
    after: merged,
    prepared: { ...PREPARED, headSha: MERGE_COMMIT },
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.deepEqual(opPayloads(calls, "prepare-review")[0]?.codeMerged, {
    pr: PR,
    sha: MERGE_COMMIT,
  });
  assert.ok(sessionsOf(calls)[0]?.task.includes(`merged as \`${MERGE_COMMIT}\``));
  assert.equal(state.stage, "merge");
  assert.deepEqual(state.review.revision, { code: MERGE_COMMIT, wiki: WIKI, inputs: INPUTS });
});

test("a code merge GitHub doesn't confirm stops before any review", async () => {
  const { ctx, calls } = review({
    state: { codeMerged: { pr: PR, sha: MERGE_COMMIT } },
    before: current({ code: MERGE_COMMIT }),
  });
  const end = await reviewerRole(ctx);
  stateOf(end, "stop");
  assert.ok(end.kind === "stop" && end.code === "error");
  assert.equal(sessionsOf(calls).length, 0);
});

test("a change that lives only in the wiki is reviewed on the issue", async () => {
  const { ctx, calls } = review({
    state: { pr: null, flows: { code: false, wiki: true } },
    before: current({}, null),
    after: current({}, null),
  });
  stateOf(await reviewerRole(ctx), "next");
  assert.equal(postsOf(calls)[0]?.on, "issue");
});

test("a failed session stops with error, and a transient one defers", async () => {
  const failedEnd = await reviewerRole(
    review({ result: { ok: false, transient: false, error: "bad reply" } }).ctx,
  );
  assert.ok(failedEnd.kind === "stop" && failedEnd.code === "error");
  const deferred = await reviewerRole(
    review({ result: { ok: false, transient: true, error: "429" } }).ctx,
  );
  assert.equal(deferred.kind, "deferred");
});

test("an op reply of an unexpected shape is an error, not a review", async () => {
  const { ctx, calls } = review({ before: { revision: { code: HEAD } } });
  await assert.rejects(reviewerRole(ctx), /current-revision: unexpected reply/u);
  assert.equal(sessionsOf(calls).length, 0);
});
