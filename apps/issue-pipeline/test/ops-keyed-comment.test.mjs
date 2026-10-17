// @ts-check
// A queued comment with a `key` on an ops request (#304): the issue's one
// comment for that key, posted once and edited after, and only ever the
// pipeline account's own. A comment with no key is posted every time.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askOps,
  commentsReply,
  effects,
  issueComment,
  reply,
} from "./ops-cli-test-kit.mjs";

const ISSUE = 7;
const MARK = `<!-- issue-pipeline:${ISSUE}:triage -->`;
const POSTED = { ok: true, op: "post", posted: 1 };
// The id of the keyed comment, and of another account's copy of it.
const OWN_ID = 901;
const OTHER_ID = 902;

/** @returns {string[]} the GitHub-visible effects of the writes, in order */
function madeInOrder() {
  return effects().map(({ effect }) => effect);
}

/** @param {string | undefined} key @returns {object} a post request with one queued comment */
function postOf(key) {
  const comment = { number: ISSUE, by: { role: "triage" }, body: "Taking" };
  if (key === undefined) {
    return { op: "post", number: ISSUE, comments: [comment] };
  }
  return { op: "post", number: ISSUE, comments: [{ ...comment, key }] };
}

/** @param {number} id @param {string} [login] @returns {object} a comment carrying the key's marker */
function marked(id, login) {
  return issueComment(id, `Taking\n${MARK}`, login);
}

test("a keyed comment sent twice is posted once and then edited", () => {
  reply([commentsReply(ISSUE, []), commentsReply(ISSUE, [marked(OWN_ID)])]);
  assert.deepEqual(askOps(postOf("triage")), POSTED);
  assert.deepEqual(askOps(postOf("triage")), POSTED);
  assert.deepEqual(madeInOrder(), [
    `comment #${ISSUE} role=triage`,
    `edit comment ${OWN_ID} role=triage`,
  ]);
  for (const { body } of effects()) {
    assert.ok(body.includes(MARK), body);
  }
});

test("a keyed comment never edits another account's comment with its marker", () => {
  reply([commentsReply(ISSUE, [marked(OTHER_ID, "mallory")])]);
  assert.deepEqual(askOps(postOf("triage")), POSTED);
  assert.deepEqual(madeInOrder(), [`comment #${ISSUE} role=triage`]);
});

test("a comment with no key is posted every time", () => {
  reply([
    commentsReply(ISSUE, [marked(OWN_ID)]),
    commentsReply(ISSUE, [marked(OWN_ID)]),
  ]);
  assert.deepEqual(askOps(postOf(undefined)), POSTED);
  assert.deepEqual(askOps(postOf(undefined)), POSTED);
  assert.deepEqual(madeInOrder(), [
    `comment #${ISSUE} role=triage`,
    `comment #${ISSUE} role=triage`,
  ]);
});
