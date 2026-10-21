// @ts-check
// The claim's branch binding (src/branch-binding.ts): a first claim binds
// the branch its job was assigned into the issue's state, and a claim whose
// assignment isn't the branch the saved state is bound to (the legacy
// agent/issue-<n> for a state saved before assignments, whose branch is
// null) is refused before it posts, labels or moves anything, so a resume
// never strands or overwrites the issue's work on its own branch.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import { issueReply, LANE, LIVE } from "../ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  reply,
  requireGhReplies,
  root,
  sh,
  stateComment,
  writes,
} from "../ops-cli-test-kit.mjs";
// ops-v2-test-kit.mjs makes the clone a claim reads.
import "../ops-v2-test-kit.mjs";

requireGhReplies();

const { newIssueState } = await import("../../src/state.ts");

// The issues: one new, one bound to another branch, one saved before
// assignments; and the id of a saved state's comment.
const NEW = 71;
const BOUND = 72;
const LEGACY = 73;
const STATE_COMMENT = 30;
const CLAIM_IDS = 100;
const ASSIGNED = "feature/bound-71";
const WORK_IS_ON =
  /#\d+'s work is on (?<bound>\S+), not the assigned (?<assigned>\S+);/u;

const CLAIM_REPLY = z.union([
  z.looseObject({
    ok: z.literal(true),
    state: z.looseObject({ branch: z.string().nullable() }),
  }),
  z.looseObject({ ok: z.literal(false), error: z.string() }),
]);

// The bound and assigned branches a refusal names.
/** @param {string} error @returns {[string | undefined, string | undefined]} */
function refusedBranches(error) {
  const { bound, assigned } = WORK_IS_ON.exec(error)?.groups ?? {};
  return [bound, assigned];
}

// A stage job's checkout of issue `n` on `branch`: a clone of origin.
/** @param {number} n @param {string} branch @returns {{ issue: number, dir: string, branch: string }} */
function checkoutOf(n, branch) {
  const dir = path.join(root, `job-claim-${n}`);
  sh(`git clone -q ${root}/origin.git ${dir}`);
  return { issue: n, dir, branch };
}

// Claims issue `n`, whose comments are `saved` (none when null), with the
// stage job's `checkout` if given.
/** @param {number} n @param {object | null} saved @param {object} [checkout] */
function claim(n, saved, checkout) {
  const read = [];
  if (saved !== null) {
    read.push(stateComment(STATE_COMMENT, saved));
  }
  const mine = claimComment(n * CLAIM_IDS, "me", "s1", LIVE);
  const branch =
    z.object({ branch: z.string() }).safeParse(checkout).data?.branch ??
    `agent/issue-${n}`;
  reply([
    historyReply(n, [], branch),
    issueReply(n),
    commentsReply(n, read),
    { when: `issues/${n}/comments -f`, stdout: JSON.stringify(mine) },
    commentsReply(n, [...read, mine]),
    commentsReply(n, [...read, mine]),
    ...claimMutationReplies(n, STATE_COMMENT, null),
  ]);
  const request = { op: "claim", number: n, ...LANE };
  if (checkout !== undefined) {
    return CLAIM_REPLY.parse(askOps({ ...request, checkout }));
  }
  return CLAIM_REPLY.parse(askOps(request));
}

test("a first claim binds the branch its job was assigned into the saved state", () => {
  const got = claim(NEW, null, checkoutOf(NEW, ASSIGNED));
  assert.ok(got.ok, JSON.stringify(got));
  assert.equal(got.state.branch, ASSIGNED);
});

test("a claim of a state bound to another branch is refused before it writes anything", () => {
  const saved = { ...newIssueState(BOUND), stage: "implement", branch: "x/y" };
  const unassigned = claim(BOUND, saved);
  assert.equal(unassigned.ok, false);
  assert.deepEqual(refusedBranches(unassigned.error), [
    "x/y",
    `agent/issue-${BOUND}`,
  ]);
  assert.deepEqual(writes(), []);
  const other = claim(BOUND, saved, checkoutOf(BOUND, "x/z"));
  assert.equal(other.ok, false);
  assert.match(other.error, WORK_IS_ON);
  assert.deepEqual(writes(), []);
});

test("a state saved before assignments keeps its legacy branch: another assignment is refused, the legacy one bound", () => {
  const legacy = {
    ...newIssueState(LEGACY),
    stage: "implement",
  };
  const switched = claim(LEGACY, legacy, checkoutOf(LEGACY, "feature/new"));
  assert.equal(switched.ok, false);
  assert.deepEqual(refusedBranches(switched.error), [
    `agent/issue-${LEGACY}`,
    "feature/new",
  ]);
  assert.deepEqual(writes(), []);
  const kept = claim(LEGACY, legacy);
  assert.ok(kept.ok, JSON.stringify(kept));
  assert.equal(kept.state.branch, `agent/issue-${LEGACY}`);
});
