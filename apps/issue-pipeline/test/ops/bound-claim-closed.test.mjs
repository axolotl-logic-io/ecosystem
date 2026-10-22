// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { prView } from "../ops-v2-test-kit.mjs";
import { boundFixture } from "./bound-claim-test-kit.mjs";

const ISSUE = 530;
const WRITER = 531;
const UNMERGED = 532;
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
    replies: [
      prView(ISSUE, PR, {
        state: "MERGED",
        headRefOid: HEAD,
        mergeCommit: { oid: RESULT },
      }),
      { when: `issue reopen ${ISSUE} `, stdout: "", keep: true },
      {
        when: `api repos/o/r/issues/${ISSUE} --jq {state}`,
        stdout: JSON.stringify({ state: "open" }),
        keep: true,
      },
      ...claimMutationReplies(ISSUE, ISSUE, PR),
    ],
  });
  const state = f.claim();
  const merged = { ...AUTHORIZED, code: RESULT };
  const security = { revision: merged, commentId: SECURITY_ID, finding: null };
  const saved = f.save({
    ...state,
    stage: "merge",
    pr: PR,
    headSha: HEAD,
    codeMerged: { pr: PR, sha: RESULT },
    hardened: AUTHORIZED,
    merged,
    security,
  });
  f.guard().release();
  const before = f.writes();
  const got = f.claimBound(f.next());
  assert.ok("state" in got);
  assert.equal(got.state.stage, "merge");
  assert.deepEqual(got.state.codeMerged, saved.codeMerged);
  assert.deepEqual(got.state.hardened, saved.hardened);
  assert.deepEqual(got.state.merged, merged);
  assert.deepEqual(got.state.security, security);
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
