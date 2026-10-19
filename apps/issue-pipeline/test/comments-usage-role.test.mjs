// @ts-check
// The pipeline's usage comments are its own records (#459): pipelineRole
// claims them for the pipeline, and they are never trusted input, so they
// never change the trusted-inputs revision that answers its questions and
// re-runs the author, and bot comments never become human input.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED, CONFIG, issueComment, reply } from "./ops-cli-test-kit.mjs";

/** @import { IssueComment } from "../src/comments.ts" */

// src loads after the kit has put the fake gh first on PATH.
const { COMMENT, pipelineRole } = await import("../src/comments.ts");
const { loadConfig } = await import("../src/config.ts");
const { trustedInputsHash } = await import("../src/issue-context.ts");

const cfg = loadConfig(CONFIG);
const ISSUE = 9;
const LATER = "2026-10-18T08:02:00Z";
const TITLE_AND_BODY = { title: "T", body: "B", user: { login: ALLOWED } };

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
reply([{ when: "api repos/o/r/collaborators/alice", stdout: "", keep: true }]);

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

test("usage comments posted after the questions don't change the trusted-inputs revision (#459)", () => {
  const before = trustedInputsHash(cfg, TITLE_AND_BODY, []);
  const comments = [comment(usageBody("usage")), comment(usageBody("usage-2"))];
  assert.equal(trustedInputsHash(cfg, TITLE_AND_BODY, comments), before);
});

test("an unmarked bot comment after the questions does not change it", () => {
  const usage = [comment(usageBody("usage-2"))];
  const before = trustedInputsHash(cfg, TITLE_AND_BODY, usage);
  const answered = [...usage, comment("Yes, keep the old behaviour.")];
  assert.equal(trustedInputsHash(cfg, TITLE_AND_BODY, answered), before);
});
