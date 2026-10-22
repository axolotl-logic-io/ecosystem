// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { prView } from "../ops-v2-test-kit.mjs";
import {
  checkpointOwnMerge,
  closedMergeReplies,
} from "./bound-claim-fixtures.mjs";
import { boundFixture } from "./bound-claim-test-kit.mjs";

const ISSUE = 530;
const WRITER = 531;
const UNMERGED = 532;
const OBSERVED = 533;
const PR = 92;
const WIDTH = 40;
const HEAD = "a".repeat(WIDTH);
const RESULT = "b".repeat(WIDTH);
const AUTHORIZED = { code: HEAD, inputs: "trusted-inputs" };
const SECURITY_ID = 73;
const NOT_OPEN = /not open|incomplete Merge/u;

test("closed incomplete Merge reopens without new approval, merge or security permission", () => {
  const f = boundFixture(ISSUE, {
    issue: { state: "closed" },
    replies: closedMergeReplies(ISSUE, PR, HEAD, RESULT),
  });
  const state = f.claim();
  const merged = { ...AUTHORIZED, code: RESULT };
  const security = { revision: merged, commentId: SECURITY_ID, finding: null };
  const work = f.save({
    ...state,
    stage: "merge",
    pr: PR,
    headSha: HEAD,
    hardened: AUTHORIZED,
    merged,
    security,
  });
  checkpointOwnMerge(f.cfg, work, {
    pr: PR,
    result: RESULT,
    authorized: AUTHORIZED,
    commentId: SECURITY_ID,
  });
  const saved = f.read();
  assert.ok(saved);
  assert.deepEqual(saved.codeMerged, { pr: PR, sha: RESULT });
  f.guard().release();
  const before = f.writes();
  const next = f.next();
  const got = f.claimBound(next);
  assert.ok("state" in got);
  assert.equal(got.state.stage, "merge");
  assert.deepEqual(got.state.codeMerged, saved.codeMerged);
  assert.deepEqual(got.state.hardened, saved.hardened);
  assert.deepEqual(got.state.merged, merged);
  assert.deepEqual(got.state.security, security);
  assert.deepEqual(got.state.mergeAttempt, saved.mergeAttempt);
  assert.deepEqual(got.state.resultSecurity, saved.resultSecurity);
  assert.deepEqual(f.read(next), got.state);
  assert.notDeepEqual(got.state.execution, saved.execution);
  const writes = f.writes().slice(before.length);
  assert.equal(writes.filter((args) => args.includes("reopen")).length, 1);
  assert.equal(
    writes.some((args) => args.some((arg) => arg.includes("/merges"))),
    false,
  );
  assert.equal(
    writes.some((args) => args.includes("review")),
    false,
  );
});

test("a newly observed merge is checkpointed before bound claim returns", () => {
  const f = boundFixture(OBSERVED, {
    replies: [
      prView(OBSERVED, PR, {
        state: "MERGED",
        headRefOid: HEAD,
        mergeCommit: { oid: RESULT },
      }),
      ...claimMutationReplies(OBSERVED, OBSERVED, PR),
    ],
  });
  const state = f.claim();
  f.save({ ...state, stage: "merge", pr: PR, headSha: HEAD });
  f.guard().release();
  const next = f.next();
  const got = f.claimBound(next);
  assert.ok("state" in got);
  assert.deepEqual(got.state.codeMerged, { pr: PR, sha: RESULT });
  assert.deepEqual(f.read(next), got.state);
  assert.equal(got.state.merged, null);
  assert.equal(got.state.hardened, null);
  assert.equal(got.state.security, null);
  assert.equal(got.state.mergeAttempt, null);
  assert.notDeepEqual(got.state.execution, state.execution);
});

test("closed writer cannot acquire or reopen even with released execution history", () => {
  const f = boundFixture(WRITER, { issue: { state: "closed" } });
  const state = f.claim();
  f.save({ ...state, stage: "implement" });
  f.guard().release();
  const before = f.writes();
  assert.throws(() => f.claimBound(f.next()), NOT_OPEN);
  assert.deepEqual(f.writes(), before);
});

test("closed recovery cannot substitute OPEN PR metadata or reopen before eligibility", () => {
  const f = boundFixture(UNMERGED, {
    issue: { state: "closed" },
    replies: [prView(UNMERGED, PR, { headRefOid: HEAD })],
  });
  const state = f.claim();
  f.save({ ...state, stage: "merge", pr: PR, headSha: HEAD });
  f.guard().release();
  const before = f.writes();
  assert.throws(() => f.claimBound(f.next()), NOT_OPEN);
  assert.deepEqual(f.writes(), before);
  assert.equal(
    f.calls().some((call) => call.args.includes("reopen")),
    false,
  );
});
