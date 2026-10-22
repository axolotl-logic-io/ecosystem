// @ts-check
// An ops request's `checkout` (#250): a stage job's own clone, which stands
// in for the named issue's worktree while the request runs, and the branch
// the caller assigned the issue, which its pushes go to. Other issues, and
// requests without it, keep their issue-N worktrees and agent/issue-N
// branches. A branch that isn't one literal name, or is the base
// branch, is refused before anything moves.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { commentLines, githubComment } from "../fake-gh.mjs";
import {
  historyReply,
  initialWriteStateReply,
} from "../initial-write-state-fixtures.mjs";
import { opsFixture } from "../ops-fixtures.mjs";

const fx = await opsFixture("ops-checkout");
fx.fakeGh.requireReplies();
const { ask, fakeGh, originRef, sh } = fx;
const { newIssueState } = await import("../../src/state.ts");
// A push's reply: its head when it pushed, its error when it didn't.
const PUSH_REPLY = z.looseObject({
  ok: z.boolean(),
  headSha: z.string().optional(),
  error: z.string().optional(),
});
const NAMES_CHECKOUT = /^bad ops request: .*→ at checkout/su;
const NOT_LITERAL = /is not a literal branch name/u;
const BASE_BRANCH = /is the base branch, which no issue works on/u;
const BOUND_ELSEWHERE =
  /#16's work is on x\/y, not the assigned feature\/bound-16/u;
const ASSIGNED = "feature/assigned-11";
// The issues each test pushes, and the issue another job's checkout names.
const VIA_CHECKOUT = 11;
const VIA_WORKTREE = 12;
const BESIDE_CHECKOUT = 13;
const OTHER_ISSUE = 99;
const VIA_ASSIGNED = 14;
const UNSAFE = 15;
const BOUND = 16;
const STATE_COMMENT = 30;
const MALFORMED = 7;

/**
 * A separate clone of origin on `branch` (issue `n`'s agent/issue-N unless
 * given) holding one commit of `file`, as a stage job's checkout would;
 * returns it, its branch and its head.
 * @param {number} n
 * @param {string} file
 * @param {string} [branch]
 * @returns {{ dir: string, branch: string, sha: string }}
 */
function jobClone(n, file, branch = `agent/issue-${n}`) {
  const dir = path.join(fx.root, `job-${n}`);
  sh(`git clone -q ${path.join(fx.root, "origin.git")} ${dir}`);
  sh(`git -C ${dir} checkout -qb ${branch}`);
  fs.writeFileSync(path.join(dir, file), "job\n");
  sh(`git -C ${dir} add ${file}`);
  sh(
    `git -C ${dir} -c user.name=J -c user.email=j@example.com -c commit.gpgsign=false commit -qm job`,
  );
  return { dir, branch, sha: sh(`git -C ${dir} rev-parse HEAD`) };
}

// The reply to a push with an explicitly saved initial premerge binding.
/** @param {{ number: number, checkout?: unknown }} request @param {string} [boundBranch] @returns {z.infer<typeof PUSH_REPLY>} */
function pushed(request, boundBranch) {
  fakeGh.reply([
    initialWriteStateReply(request.number, boundBranch),
    historyReply(request.number, [], boundBranch),
  ]);
  return PUSH_REPLY.parse(JSON.parse(ask({ op: "push", ...request })));
}

test("push with a checkout pushes that clone's commit, not the issue's worktree", () => {
  const { dir, branch, sha } = jobClone(VIA_CHECKOUT, "job.txt");
  const reply = pushed({
    number: VIA_CHECKOUT,
    checkout: { issue: VIA_CHECKOUT, dir, branch },
  });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.headSha, sha);
  assert.equal(originRef(`agent/issue-${VIA_CHECKOUT}`), sha);
  assert.equal(fs.existsSync(fx.worktree(VIA_CHECKOUT)), false);
});

test("push without a checkout pushes from the issue's worktree", () => {
  fx.startBranch(VIA_WORKTREE, "a.txt", "first");
  const sha = fx.commitIn(VIA_WORKTREE, "b.txt", "second");
  const reply = pushed({ number: VIA_WORKTREE });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(originRef(`agent/issue-${VIA_WORKTREE}`), sha);
});

test("a checkout naming another issue leaves the request's issue on its worktree", () => {
  const { dir, branch } = jobClone(OTHER_ISSUE, "other.txt");
  fx.startBranch(BESIDE_CHECKOUT, "a.txt", "first");
  const sha = fx.commitIn(BESIDE_CHECKOUT, "b.txt", "second");
  const reply = pushed({
    number: BESIDE_CHECKOUT,
    checkout: { issue: OTHER_ISSUE, dir, branch },
  });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(originRef(`agent/issue-${BESIDE_CHECKOUT}`), sha);
  assert.equal(originRef(`agent/issue-${OTHER_ISSUE}`), "");
});

test("a malformed checkout is refused, naming checkout", () => {
  const malformed = [
    { issue: String(MALFORMED), dir: "/x", branch: "b" },
    { issue: MALFORMED, dir: "", branch: "b" },
    { issue: MALFORMED, dir: "/x" },
    { issue: MALFORMED, dir: "/x", branch: "" },
  ];
  for (const checkout of malformed) {
    const reply = pushed({ number: MALFORMED, checkout });
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", NAMES_CHECKOUT);
  }
});

test("push with an assigned branch pushes the job's commit to exactly that branch", () => {
  const { dir, branch, sha } = jobClone(VIA_ASSIGNED, "assigned.txt", ASSIGNED);
  const reply = pushed(
    {
      number: VIA_ASSIGNED,
      checkout: { issue: VIA_ASSIGNED, dir, branch },
    },
    ASSIGNED,
  );
  assert.equal(reply.ok, true, reply.error);
  assert.equal(originRef(ASSIGNED), sha);
  assert.equal(originRef(`agent/issue-${VIA_ASSIGNED}`), "");
});

test("a checkout's branch that is a ref expression, an option, or the base branch pushes nothing", () => {
  const { dir, sha } = jobClone(UNSAFE, "unsafe.txt", "feature/unsafe-15");
  /** @type {[string, RegExp][]} */
  const refused = [
    ["HEAD", NOT_LITERAL],
    ["integration", BASE_BRANCH],
  ];
  for (const [branch, why] of refused) {
    const reply = pushed({
      number: UNSAFE,
      checkout: { issue: UNSAFE, dir, branch },
    });
    assert.equal(reply.ok, false, branch);
    assert.match(reply.error ?? "", why);
  }
  assert.equal(originRef("integration") === sha, false);
  assert.equal(originRef("feature/unsafe-15"), "");
});

test("push refuses a saved state bound to another branch than the checkout's, pushing nothing", () => {
  const { dir, branch } = jobClone(BOUND, "bound.txt", "feature/bound-16");
  const saved = { ...newIssueState(BOUND), branch: "x/y" };
  const body = `<!-- agent-pipeline:state\n${JSON.stringify(saved)}\n-->`;
  const at = "2026-10-15T01:00:00Z";
  const comment = githubComment({
    id: STATE_COMMENT,
    body,
    login: "a",
    created: at,
    updated: at,
  });
  fakeGh.reply([
    {
      when: `issues/${BOUND}/comments?per_page`,
      stdout: commentLines([comment]),
    },
  ]);
  const reply = PUSH_REPLY.parse(
    JSON.parse(
      ask({
        op: "push",
        number: BOUND,
        checkout: { issue: BOUND, dir, branch },
      }),
    ),
  );
  assert.equal(reply.ok, false);
  assert.match(reply.error ?? "", BOUND_ELSEWHERE);
  assert.equal(originRef("feature/bound-16"), "");
  assert.equal(originRef("x/y"), "");
});
