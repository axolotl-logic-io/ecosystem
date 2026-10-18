// @ts-check
// The pipeline's usage comments are its own records (#459): pipelineRole
// claims them for the pipeline, and they never answer its questions, while a
// comment by the same account with no pipeline mark still does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED, CONFIG, issueComment, reply } from "./ops-cli-test-kit.mjs";

/** @import { IssueComment } from "../src/comments.ts" */

// src loads after the kit has put the fake gh first on PATH.
const { COMMENT, pipelineRole } = await import("../src/comments.ts");
const { loadConfig } = await import("../src/config.ts");
const { answeredSince } = await import("../src/ops/sweep-verdict.ts");

const cfg = loadConfig(CONFIG);
const ISSUE = 9;
const ASKED_AT = "2026-10-18T08:00:00Z";
const LATER = "2026-10-18T08:02:00Z";
const STATE = { stage: "triage", questionsAt: ASKED_AT };

// The body of the issue's `kind` usage comment (`usage`, `usage-2`, ...), as
// src/job/usage-comment.ts lays it out.
/** @param {string} kind @returns {string} */
function usageBody(kind) {
  return `Issue pipeline usage records (hidden; see the wiki)\n<!-- issue-pipeline:${ISSUE}:${kind} -->\n<!--\n{"kind":"job","issue":${ISSUE}}\n-->`;
}

let lastId = 0;

// A comment as listComments reads it, by the pipeline's account unless
// `login` says otherwise, posted after the questions.
/** @param {string} body @param {string} [login] @returns {IssueComment} */
function comment(body, login) {
  lastId += 1;
  return COMMENT.parse(issueComment(lastId, body, login, LATER));
}

// The fake gh answers every collaborator check with success.
reply([]);

test("the account's usage comments are the pipeline's usage records", () => {
  assert.equal(pipelineRole(cfg, comment(usageBody("usage"))), "usage");
  assert.equal(pipelineRole(cfg, comment(usageBody("usage-2"))), "usage");
});

test("a usage comment's body from another user is not the pipeline's", () => {
  assert.equal(pipelineRole(cfg, comment(usageBody("usage"), ALLOWED)), null);
});

test("a signed pipeline comment that quotes a usage mark keeps its role", () => {
  const body = `**🤖 issue-pipeline · spec writer**\n<!-- agent-pipeline:comment role=spec-writer -->\n\nThe test posts \`<!-- issue-pipeline:${ISSUE}:usage -->\`.`;
  assert.equal(pipelineRole(cfg, comment(body)), "spec-writer");
});

test("usage comments posted after the questions don't answer them (#459)", () => {
  const comments = [comment(usageBody("usage")), comment(usageBody("usage-2"))];
  assert.equal(answeredSince(cfg, comments, STATE), false);
});

test("an unmarked comment by the account after the questions answers them", () => {
  const comments = [
    comment(usageBody("usage-2")),
    comment("Yes, keep the old behaviour."),
  ];
  assert.equal(answeredSince(cfg, comments, STATE), true);
});
