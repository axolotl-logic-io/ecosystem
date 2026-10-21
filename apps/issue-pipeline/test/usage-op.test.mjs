// @ts-check
// The ops `usage` op (#302): it appends a usage record line to the account's
// latest usage comment on the issue, posts the next comment once that one is
// full, and ignores a marked comment another account wrote.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { commentWriteReplies } from "./gh-mutation-fixtures.mjs";
import {
  askOps,
  commentsReply,
  issueComment,
  reply,
  writes,
} from "./ops-cli-test-kit.mjs";
import { sessionRecord } from "./usage-fixtures.mjs";

const { serializeUsage } = await import("../src/job/usage-log.ts");
const { appendedBody, usageBody, usageLines } = await import(
  "../src/job/usage-comment.ts"
);

const N = 7;
const LIMIT = 65_536;
const OLD = serializeUsage(sessionRecord({ attempt: 1 }));
const NEW = serializeUsage(sessionRecord({ attempt: 2 }));
const OTHER_ID = 40;
const USAGE_ID = 41;
const USAGE_2_ID = 42;
const SECOND = 2;
const EDITED = z.object({ edited: z.boolean() });
const OK = z.object({ ok: z.boolean() });

/** @param {readonly string[]} args @returns {string} the body a write sends */
function bodyOf(args) {
  const field = args.find((arg) => arg.startsWith("body="));
  return field?.slice("body=".length) ?? "";
}

/** @param {readonly string[]} args @returns {string} what a write does, and where */
function targetOf(args) {
  const method = args[args.indexOf("-X") + 1];
  const where = args.find((arg) => arg.startsWith("repos/")) ?? "";
  return `${method} ${where}`;
}

/** @param {readonly string[]} args @returns {unknown[]} the attempts of the records a write sends */
function attemptsOf(args) {
  return usageLines(bodyOf(args)).map((line) => JSON.parse(line).attempt);
}

/** @returns {string} issue 7's first usage comment, holding as many lines as fit */
function fullBody() {
  let body = usageBody(N, 1, [OLD]);
  let next = appendedBody(body, OLD);
  while (next !== null) {
    body = next;
    next = appendedBody(body, OLD);
  }
  return body;
}

/** @param {readonly unknown[]} comments @param {string} line */
function append(comments, line = NEW) {
  reply([
    { ...commentsReply(N, comments), keep: true },
    ...commentWriteReplies("o/r", N, [USAGE_ID, USAGE_2_ID]),
  ]);
  return askOps({ op: "usage", number: N, line });
}

test("an append edits the account's usage comment in place, keeping its lines", () => {
  const usage = issueComment(USAGE_ID, usageBody(N, 1, [OLD]));
  const answer = append([issueComment(OTHER_ID, "hello"), usage]);
  assert.deepEqual(answer, {
    ok: true,
    op: "usage",
    posted: 0,
    commentIds: [],
    usageComment: 1,
    edited: true,
  });
  const done = writes();
  assert.deepEqual(done.map(targetOf), [
    `PATCH repos/o/r/issues/comments/${USAGE_ID}`,
  ]);
  assert.deepEqual(attemptsOf(done[0] ?? []), [1, 2]);
});

test("the highest-numbered usage comment takes the append", () => {
  const first = issueComment(USAGE_ID, usageBody(N, 1, [OLD]));
  const second = issueComment(USAGE_2_ID, usageBody(N, SECOND, [OLD]));
  append([second, first]);
  assert.deepEqual(writes().map(targetOf), [
    `PATCH repos/o/r/issues/comments/${USAGE_2_ID}`,
  ]);
});

test("another account's marked comment is ignored, and the first is posted", () => {
  const forged = issueComment(USAGE_ID, usageBody(N, 1, [OLD]), "mallory");
  const answer = append([forged]);
  assert.equal(EDITED.parse(answer).edited, false);
  const done = writes();
  assert.deepEqual(done.map(targetOf), ["POST repos/o/r/issues/7/comments"]);
  const body = bodyOf(done[0] ?? []);
  assert.ok(body.includes("<!-- issue-pipeline:7:usage -->"));
  assert.ok(
    body.startsWith(
      "Issue pipeline usage records (hidden; described in the issue pipeline's docs/reference/)",
    ),
  );
  assert.deepEqual(attemptsOf(done[0] ?? []), [2]);
});

test("a full comment makes the append post usage-2", () => {
  const full = fullBody();
  assert.ok(full.length <= LIMIT);
  const answer = append([issueComment(USAGE_ID, full)]);
  assert.deepEqual(answer, {
    ok: true,
    op: "usage",
    posted: 0,
    commentIds: [],
    usageComment: SECOND,
    edited: false,
  });
  const done = writes();
  assert.deepEqual(done.map(targetOf), ["POST repos/o/r/issues/7/comments"]);
  const body = bodyOf(done[0] ?? []);
  assert.ok(body.includes("<!-- issue-pipeline:7:usage-2 -->"));
  assert.deepEqual(attemptsOf(done[0] ?? []), [2]);
});

test("a line that is no usage record is refused, and nothing is written", () => {
  for (const line of ["free text", `${NEW.slice(0, -1)},"note":"-->"}`]) {
    const answer = append([], line);
    assert.equal(OK.parse(answer).ok, false);
    assert.deepEqual(writes(), []);
  }
});
