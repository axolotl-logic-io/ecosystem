// @ts-check
// An ops request's `checkout` (#250): a stage job's own clone, which stands
// in for the named issue's worktree while the request runs. Other issues,
// and requests without it, keep their issue-N worktrees.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("ops-checkout");
const { ask, fakeGh, originRef, sh } = fx;
// A push's reply: its head when it pushed, its error when it didn't.
const PUSH_REPLY = z.looseObject({
  ok: z.boolean(),
  headSha: z.string().optional(),
  error: z.string().optional(),
});
const NAMES_CHECKOUT = /^bad ops request: .*→ at checkout/su;
// The issues each test pushes, and the issue another job's checkout names.
const VIA_CHECKOUT = 11;
const VIA_WORKTREE = 12;
const BESIDE_CHECKOUT = 13;
const OTHER_ISSUE = 99;
const MALFORMED = 7;

/**
 * A separate clone of origin on issue `n`'s branch holding one commit of
 * `file`, as a stage job's checkout would; returns it and its head.
 * @param {number} n
 * @param {string} file
 * @returns {{ dir: string, sha: string }}
 */
function jobClone(n, file) {
  const dir = path.join(fx.root, `job-${n}`);
  sh(`git clone -q ${path.join(fx.root, "origin.git")} ${dir}`);
  sh(`git -C ${dir} checkout -qb agent/issue-${n}`);
  fs.writeFileSync(path.join(dir, file), "job\n");
  sh(`git -C ${dir} add ${file}`);
  sh(
    `git -C ${dir} -c user.name=J -c user.email=j@example.com -c commit.gpgsign=false commit -qm job`,
  );
  return { dir, sha: sh(`git -C ${dir} rev-parse HEAD`) };
}

// The reply to a push `request`, with no saved state for its issue, so the
// push reads an empty comment list.
/** @param {object} request @returns {z.infer<typeof PUSH_REPLY>} */
function pushed(request) {
  fakeGh.reply([]);
  return PUSH_REPLY.parse(JSON.parse(ask({ op: "push", ...request })));
}

test("push with a checkout pushes that clone's commit, not the issue's worktree", () => {
  const { dir, sha } = jobClone(VIA_CHECKOUT, "job.txt");
  const reply = pushed({
    number: VIA_CHECKOUT,
    checkout: { issue: VIA_CHECKOUT, dir },
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
  const { dir } = jobClone(OTHER_ISSUE, "other.txt");
  fx.startBranch(BESIDE_CHECKOUT, "a.txt", "first");
  const sha = fx.commitIn(BESIDE_CHECKOUT, "b.txt", "second");
  const reply = pushed({
    number: BESIDE_CHECKOUT,
    checkout: { issue: OTHER_ISSUE, dir },
  });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(originRef(`agent/issue-${BESIDE_CHECKOUT}`), sha);
  assert.equal(originRef(`agent/issue-${OTHER_ISSUE}`), "");
});

test("a malformed checkout is refused, naming checkout", () => {
  const malformed = [
    { issue: String(MALFORMED), dir: "/x" },
    { issue: MALFORMED, dir: "" },
  ];
  for (const checkout of malformed) {
    const reply = pushed({ number: MALFORMED, checkout });
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", NAMES_CHECKOUT);
  }
});
