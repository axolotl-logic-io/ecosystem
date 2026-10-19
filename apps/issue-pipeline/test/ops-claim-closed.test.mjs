// @ts-check
// Closed issue recovery validates authority and merged provenance before any
// claim, replacement state, working label or reopen can be written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { collaboratorReply } from "./gh-mutation-fixtures.mjs";
import { issueReply } from "./ops-claim-test-kit.mjs";
import { requireGhReplies } from "./ops-cli-test-kit.mjs";
import {
  everyCommentsRead,
  kit,
  LANE,
  prView,
  v2State,
} from "./ops-v2-test-kit.mjs";

requireGhReplies();
const { askOps, reply, stateComment, writes, claimComment } = kit;
const ISSUE = 401;
const PR = 50;
const SHA_LENGTH = 40;
const HEAD = "0".repeat(SHA_LENGTH);
const MERGE = "a".repeat(SHA_LENGTH);
const SAVED = v2State(ISSUE, { stage: "merge", pr: PR, headSha: HEAD });
const MERGED = { state: "MERGED", mergeCommit: { oid: MERGE } };
const REPLY = z.object({
  ok: z.boolean(),
  lost: z.boolean().optional(),
  holder: z.string().optional(),
});
const COMMENT_BODY = z.looseObject({ body: z.string() });

/** @param {readonly unknown[]} comments @param {object} [view] */
function closedWorld(comments, view = MERGED) {
  reply([
    collaboratorReply("o/r", "alice"),
    issueReply(ISSUE, { state: "closed" }),
    everyCommentsRead(ISSUE, comments),
    prView(ISSUE, PR, view),
  ]);
}

test("closed issue without saved pipeline state cannot initialize work", () => {
  closedWorld([]);
  assert.equal(
    REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
    false,
  );
  assert.deepEqual(writes(), []);
});

for (const [name, extra] of Object.entries({
  done: { stage: "done", merged: { code: MERGE, wiki: null, inputs: "x" } },
  author: { stage: "author" },
  implement: { stage: "implement" },
  review: { stage: "review" },
  "stopped outside Merge": { stage: "stopped", stoppedStage: "review" },
  "no recorded PR": { pr: null },
  "state for another issue": { number: ISSUE + 1 },
  "legacy state": { version: 1 },
  "stopped completion replay": { stage: "stopped", stoppedStage: "done" },
  "malformed code receipt": { codeMerged: { pr: PR } },
  "contradicted code receipt": { codeMerged: { pr: PR, sha: "other" } },
  "contradicted PR receipt": { codeMerged: { pr: PR + 1, sha: MERGE } },
  "contradicted own receipt": {
    merged: { code: "other", wiki: null, inputs: "x" },
  },
  "changed retained head": { headSha: "other" },
  "contradicted original own-merge head": {
    headSha: MERGE,
    codeMerged: { pr: PR, sha: MERGE },
    merged: { code: MERGE, wiki: null, inputs: "x" },
    hardened: { code: "b".repeat(SHA_LENGTH), wiki: null, inputs: "x" },
  },
})) {
  test(`closed issue with ${name} is refused without mutations`, () => {
    closedWorld([stateComment(1, { ...SAVED, ...extra })]);
    assert.equal(
      REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
      false,
    );
    assert.deepEqual(writes(), []);
  });
}

for (const [name, view] of Object.entries({
  open: { state: "OPEN", mergeCommit: null },
  "inconsistent open merge evidence": {
    state: "OPEN",
    mergeCommit: { oid: MERGE },
  },
  "another recorded PR": { ...MERGED, number: PR + 1 },
  "closed unmerged": { state: "CLOSED", mergeCommit: null },
  "missing merged result": { state: "MERGED", mergeCommit: null },
  "malformed merged result": { ...MERGED, mergeCommit: { oid: "not-an-oid" } },
  "abbreviated merged result": { ...MERGED, mergeCommit: { oid: "abcd123" } },
  "blank merged result": { ...MERGED, mergeCommit: { oid: " " } },
  "wrong configured base": { ...MERGED, baseRefName: "elsewhere" },
  "wrong branch": { ...MERGED, headRefName: "elsewhere" },
  fork: { ...MERGED, isCrossRepository: true },
})) {
  test(`closed issue whose PR is ${name} is refused without mutations`, () => {
    closedWorld([stateComment(1, SAVED)], view);
    assert.equal(
      REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
      false,
    );
    assert.deepEqual(writes(), []);
  });
}

test("malformed retained PR head cannot confirm closed recovery even without a saved head", () => {
  closedWorld([stateComment(1, { ...SAVED, headSha: null })], {
    ...MERGED,
    headRefOid: "not-an-oid",
  });
  assert.equal(
    REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
    false,
  );
  assert.deepEqual(writes(), []);
});

test("unreadable merged metadata never grants closed recovery", () => {
  reply([
    collaboratorReply("o/r", "alice"),
    issueReply(ISSUE, { state: "closed" }),
    everyCommentsRead(ISSUE, [stateComment(1, SAVED)]),
    { when: `pr view ${PR} `, code: 1, stderr: "unreadable merge", keep: true },
  ]);
  assert.equal(
    REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
    false,
  );
  assert.deepEqual(writes(), []);
});

test("a malformed latest state cannot fall back to an older eligible Merge", () => {
  const malformed = COMMENT_BODY.parse(stateComment(2, SAVED));
  closedWorld([
    stateComment(1, SAVED),
    { ...malformed, body: malformed.body.replace(JSON.stringify(SAVED), "{") },
  ]);
  assert.equal(
    REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
    false,
  );
  assert.deepEqual(writes(), []);
});

test("a state without merge authorship cannot authorize closed recovery", () => {
  closedWorld([{ ...stateComment(1, SAVED), user: { login: "alice" } }]);
  assert.equal(
    REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
    false,
  );
  assert.deepEqual(writes(), []);
});

test("untrusted editing of otherwise eligible Merge state refuses closed recovery", () => {
  closedWorld([
    stateComment(1, SAVED),
    {
      ...stateComment(2, SAVED),
      lastEditedAt: new Date().toISOString(),
      editor: { login: "alice" },
    },
  ]);
  assert.equal(
    REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
    false,
  );
  assert.deepEqual(writes(), []);
});

test("eligible closed recovery does not override another lane's live claim", () => {
  closedWorld([
    stateComment(1, SAVED),
    claimComment(2, "other", "s0", new Date().toISOString()),
  ]);
  const result = REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE }));
  assert.equal(result.ok, true);
  assert.equal(result.lost, true);
  assert.equal(result.holder, "other");
  assert.deepEqual(writes(), []);
});

for (const [name, confirmation] of Object.entries({
  "still closed": { stdout: JSON.stringify({ state: "closed" }) },
  unreadable: { code: 1, stderr: "issue unavailable" },
  "missing state": { stdout: "{}" },
})) {
  test(`closed recovery whose reopen is ${name} cannot save state or start work`, () => {
    reply([
      collaboratorReply("o/r", "alice"),
      issueReply(ISSUE, { state: "closed" }),
      everyCommentsRead(ISSUE, [
        stateComment(1, SAVED),
        claimComment(2, LANE.lane, LANE.sweepId, new Date().toISOString()),
      ]),
      prView(ISSUE, PR, MERGED),
      { when: `issue reopen ${ISSUE} `, stdout: "" },
      { when: `api repos/o/r/issues/${ISSUE} --jq`, ...confirmation },
    ]);
    assert.equal(
      REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
      false,
    );
    // A successful reopen command alone is not confirmation of recovery.
    // In particular, don't replace the saved Merge with leased writer state.
    assert.deepEqual(writes(), [
      ["issue", "reopen", String(ISSUE), "-R", "o/r"],
    ]);
  });
}

test("eligible closed recovery refuses another assigned branch", () => {
  closedWorld([stateComment(1, { ...SAVED, branch: "another-assignment" })]);
  assert.equal(
    REPLY.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).ok,
    false,
  );
  assert.deepEqual(writes(), []);
});
