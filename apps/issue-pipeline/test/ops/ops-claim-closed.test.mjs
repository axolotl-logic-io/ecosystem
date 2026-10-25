// @ts-check
// Closed issue recovery validates authority and merged provenance before any
// claim, replacement state, working label or reopen can be written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { loseOwnership } from "../fake-ownership.mjs";
import { collaboratorReply } from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import { issueReply } from "../ops-claim-test-kit.mjs";
import { requireGhReplies } from "../ops-cli-test-kit.mjs";
import {
  everyCommentsRead,
  kit,
  LANE,
  prView,
  receiptCheckpoint,
  savedStates,
  v2State,
} from "../ops-v2-test-kit.mjs";
import {
  ATTEMPT_UNCONFIRMED,
  INVALID_JSON,
  MERGE_UNCONFIRMED,
  NOT_OPEN,
  PR_REFUSALS,
  PROVENANCE,
  REOPEN_UNCONFIRMED,
  refusalOf,
  STATE_REFUSALS,
  UNREADABLE_MERGE,
  WRONG_BRANCH,
} from "./ops-claim-closed-fixtures.mjs";

requireGhReplies();
const { askOps, reply, savedStateComment, writes, claimComment } = kit;
const ISSUE = 401;
const PR = 50;
const SHA_LENGTH = 40;
const HEAD = "0".repeat(SHA_LENGTH);
const MERGE = "a".repeat(SHA_LENGTH);
const SAVED = v2State(ISSUE, { stage: "merge", pr: PR, headSha: HEAD });
const MERGED = { state: "MERGED", mergeCommit: { oid: MERGE } };
// What an owner whose issue a successor took reads (coordination-records.ts).
const RELEASED = /released instance cannot request again/u;
// A state comment's JSON line.
const STATE_JSON = /\n\{.*\}\n/u;
const AUTHORIZED = { code: HEAD, inputs: "x" };
const ATTEMPT = {
  repo: "o/r",
  pr: PR,
  target: "integration",
  branch: `agent/issue-${ISSUE}`,
  authorized: AUTHORIZED,
  hardened: AUTHORIZED,
  integration: null,
  result: MERGE,
  reads: 1,
};
const REFUSED = z.object({ ok: z.literal(false), error: z.string() });
const COMMENT_BODY = z.looseObject({ body: z.string() });

/** @param {readonly unknown[]} comments @param {object} [view] */
function closedWorld(comments, view = MERGED) {
  reply([
    collaboratorReply("o/r", "alice"),
    historyReply(ISSUE),
    issueReply(ISSUE, { state: "closed" }),
    everyCommentsRead(ISSUE, comments),
    prView(ISSUE, PR, view),
  ]);
}

test("closed issue without saved pipeline state cannot initialize work", () => {
  closedWorld([]);
  assert.match(
    REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
    NOT_OPEN,
  );
  assert.deepEqual(writes(), []);
});

for (const [name, extra] of Object.entries({
  done: { stage: "done", merged: { code: MERGE, inputs: "x" } },
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
    merged: { code: "other", inputs: "x" },
  },
  "changed retained head": { headSha: "other" },
  "contradicted original own-merge head": {
    headSha: MERGE,
    codeMerged: { pr: PR, sha: MERGE },
    merged: { code: MERGE, inputs: "x" },
    hardened: { code: "b".repeat(SHA_LENGTH), inputs: "x" },
  },
})) {
  test(`closed issue with ${name} is refused without mutations`, () => {
    closedWorld([savedStateComment(1, { ...SAVED, ...extra })]);
    assert.match(
      REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
      refusalOf(STATE_REFUSALS, name),
    );
    assert.deepEqual(writes(), []);
  });
}

for (const [name, extra] of Object.entries({
  "different response result": { result: "b".repeat(SHA_LENGTH) },
  "different source head": {
    authorized: { ...AUTHORIZED, code: "b".repeat(SHA_LENGTH) },
  },
  "different PR": { pr: PR + 1 },
  "different repository": { repo: "another/repo" },
  "different target": { target: "another-base" },
  "different branch": { branch: "another-branch" },
})) {
  test(`closed recovery refuses a saved merge attempt with ${name} before mutations`, () => {
    closedWorld([
      savedStateComment(1, {
        ...SAVED,
        headSha: null,
        hardened: AUTHORIZED,
        mergeAttempt: { ...ATTEMPT, ...extra },
      }),
    ]);
    assert.match(
      REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
      ATTEMPT_UNCONFIRMED,
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
    closedWorld([savedStateComment(1, SAVED)], view);
    assert.match(
      REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
      refusalOf(PR_REFUSALS, name),
    );
    assert.deepEqual(writes(), []);
  });
}

test("malformed retained PR head cannot confirm closed recovery even without a saved head", () => {
  closedWorld([savedStateComment(1, { ...SAVED, headSha: null })], {
    ...MERGED,
    headRefOid: "not-an-oid",
  });
  assert.match(
    REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
    MERGE_UNCONFIRMED,
  );
  assert.deepEqual(writes(), []);
});

test("unreadable merged metadata never grants closed recovery", () => {
  reply([
    collaboratorReply("o/r", "alice"),
    issueReply(ISSUE, { state: "closed" }),
    everyCommentsRead(ISSUE, [savedStateComment(1, SAVED)]),
    { when: `pr view ${PR} `, code: 1, stderr: "unreadable merge", keep: true },
  ]);
  assert.match(
    REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
    UNREADABLE_MERGE,
  );
  assert.deepEqual(writes(), []);
});

test("a malformed latest state cannot fall back to an older eligible Merge", () => {
  const malformed = COMMENT_BODY.parse(savedStateComment(2, SAVED));
  closedWorld([
    savedStateComment(1, SAVED),
    { ...malformed, body: malformed.body.replace(STATE_JSON, "\n{\n") },
  ]);
  assert.match(
    REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
    INVALID_JSON,
  );
  assert.deepEqual(writes(), []);
});

// The provenance check of every comment listing refuses it first, so not
// even a job's ownership read gets past it (#167).
test("a state without merge authorship cannot authorize closed recovery", () => {
  closedWorld([{ ...savedStateComment(1, SAVED), user: { login: "alice" } }]);
  assert.match(
    REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
    PROVENANCE,
  );
  assert.deepEqual(writes(), []);
});

test("untrusted editing of otherwise eligible Merge state refuses closed recovery", () => {
  closedWorld([
    savedStateComment(1, SAVED),
    {
      ...savedStateComment(2, SAVED),
      lastEditedAt: new Date().toISOString(),
      editor: { login: "alice" },
    },
  ]);
  assert.match(
    REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
    PROVENANCE,
  );
  assert.deepEqual(writes(), []);
});

test("eligible closed recovery does not override another invocation that takes the issue", () => {
  closedWorld([savedStateComment(1, SAVED)]);
  const request = { op: "claim", number: ISSUE, ...LANE };
  loseOwnership();
  assert.match(REFUSED.parse(askOps(request)).error, RELEASED);
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
        savedStateComment(1, SAVED),
        claimComment(2, LANE.lane, LANE.sweepId, new Date().toISOString()),
      ]),
      prView(ISSUE, PR, MERGED),
      { when: `issue reopen ${ISSUE} `, stdout: "" },
      { when: `api repos/o/r/issues/${ISSUE} --jq`, ...confirmation },
    ]);
    assert.match(
      REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
      REOPEN_UNCONFIRMED,
    );
    // A successful reopen command alone is not confirmation of recovery.
    // In particular, don't replace the saved Merge with leased writer state:
    // only the receipt checkpoint before it (#167) and the reopen are made.
    assert.deepEqual(savedStates(), [receiptCheckpoint(SAVED)]);
    assert.deepEqual(writes().slice(1), [
      ["issue", "reopen", String(ISSUE), "-R", "o/r"],
    ]);
  });
}

test("eligible closed recovery refuses another assigned branch", () => {
  closedWorld([
    savedStateComment(1, { ...SAVED, branch: "another-assignment" }),
  ]);
  assert.match(
    REFUSED.parse(askOps({ op: "claim", number: ISSUE, ...LANE })).error,
    WRONG_BRANCH,
  );
  assert.deepEqual(writes(), []);
});
