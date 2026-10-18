// @ts-check
// The reviewer role through a fake RoleContext: one read-only session per
// round, a verdict bound to the exact revision it saw, posted in the round's
// own comment, a security finding that stops whatever the verdict, numbered
// findings and the fix-round bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endCode,
  firstPayload,
  opNames,
  postsOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  approvedReview,
  COMMENT_ID,
  cfg,
  current,
  GHERKIN_TEXT,
  HEAD,
  LIMITS,
  MOVED,
  REVISION,
  reviewerRole,
  SHORT_SHA_LENGTH,
} from "./reviewer-and-merge-role-kit.mjs";
import {
  BLOCKING,
  BLOCKING_LINE,
  PREPARED,
  review,
  verdict,
} from "./reviewer-role-test-kit.mjs";

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
  assert.ok(
    lastRead > sessionAt,
    "the revision is read again after the session",
  );
  assert.equal(state.stage, "merge");
  assert.equal(state.review.verdict, "approve");
  assert.deepEqual(state.review.revision, REVISION);
  assert.equal(state.review.commentId, COMMENT_ID);
  const posts = postsOf(calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.key, "review-r1");
  const { tag } = firstPayload(calls, "prepare-review");
  assert.equal(tag, "r1");
  assert.equal(posts[0]?.on, "pr");
  assert.equal(posts[0]?.role, "reviewer");
  assert.ok(posts[0]?.body.includes(HEAD.slice(0, SHORT_SHA_LENGTH)));
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
  assert.equal(endCode(end), "rights");
  assert.ok(JSON.stringify(end).includes("It shares chats publicly."));
  assert.equal(state.review.verdict, null);
  assert.equal(state.stage, "review");
  assert.equal(postsOf(calls).length, 0);
});

test("changes number the findings on from the last round's, in the round's own comment, and go back to implement", async () => {
  const previous = ["old 1", "old 2", "old 3"].map((text, index) => ({
    id: index + 1,
    severity: /** @type {const} */ ("blocking"),
    text,
  }));
  const { ctx, calls } = review({
    state: {
      review: {
        ...approvedReview(),
        verdict: "changes",
        round: 1,
        findings: previous,
      },
    },
    result: verdict({
      verdict: "changes",
      findings: [
        BLOCKING,
        { severity: "note", text: "A name could be clearer." },
      ],
    }),
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.equal(state.review.round, 2);
  assert.equal(state.review.verdict, "changes");
  assert.deepEqual(
    state.review.findings.map((finding) => finding.id),
    [previous.length + 1, previous.length + 2],
  );
  assert.ok(sessionsOf(calls)[0]?.task.includes("#3 [blocking] old 3"));
  assert.ok(
    postsOf(calls)[0]?.body.includes(
      `#4 [blocking] (src/chat.ts:${BLOCKING_LINE})`,
    ),
  );
  // Round 2 posts its own comment, never editing round 1's.
  assert.equal(postsOf(calls)[0]?.key, "review-r2");
  const { tag } = firstPayload(calls, "prepare-review");
  assert.equal(tag, "r2");
});

test("an approval with a blocking finding counts as changes", async () => {
  const { ctx } = review({ result: verdict({ findings: [BLOCKING] }) });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.equal(state.review.verdict, "changes");
});

test("changes are allowed for exactly maxFixRounds rounds, then stop", async () => {
  const changes = verdict({ verdict: "changes", findings: [BLOCKING] });
  const lastRound = LIMITS.maxFixRounds - 1;
  const last = review({
    state: {
      review: { ...approvedReview(), verdict: "changes", round: lastRound },
    },
    result: changes,
  });
  assert.equal(
    stateOf(await reviewerRole(last.ctx), "next").review.round,
    LIMITS.maxFixRounds,
  );
  const past = review({
    state: {
      review: {
        ...approvedReview(),
        verdict: "changes",
        round: LIMITS.maxFixRounds,
      },
    },
    result: changes,
  });
  const end = await reviewerRole(past.ctx);
  stateOf(end, "stop");
  assert.equal(endCode(end), "review-rounds");
});
