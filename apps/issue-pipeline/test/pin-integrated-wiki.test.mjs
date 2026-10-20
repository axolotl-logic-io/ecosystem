// @ts-check
// Final pinning is a guarded local code write, before exact-head checks.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  historyReply,
  initialWriteStateReply,
} from "./initial-write-state-fixtures.mjs";
import { opsFixture } from "./ops-fixture.mjs";
import { addWiki, pinAt, wikiAhead } from "./wiki-pin-test-kit.mjs";

const fx = await opsFixture("pin-integrated-wiki");
fx.fakeGh.requireReplies();
addWiki(fx);
const FULL_SHA_LENGTH = 40;
const PR = 42;
const config = fx.configWith("wiki.json", { wiki: true });
const { loadConfig } = await import("../src/config.ts");
const { ensureWorktree } = await import("../src/checkouts.ts");
const { newIssueState } = await import("../src/state.ts");
const cfg = loadConfig(config);

/** @param {number} n */
function branch(n) {
  fx.fetchClone();
  ensureWorktree(cfg, n);
  fx.commitIn(n, `code${n}`, "code");
  fx.pushFrom(n);
  const wt = fx.worktree(n);
  const integrated = wikiAhead(wt, `Page${n}`);
  return {
    wt,
    integrated,
    before: fx.worktreeState(n),
    pin: pinAt(wt, "HEAD"),
  };
}

/** @param {number} n @param {Partial<import("../src/state.ts").IssueState>} [patch] @param {boolean} [liveMerged] */
function ask(n, patch = {}, liveMerged = false) {
  const reply = initialWriteStateReply(n);
  const state = {
    ...newIssueState(n),
    stage: "merge",
    branch: `agent/issue-${n}`,
    flows: { code: true, wiki: true },
    ...patch,
  };
  if (liveMerged) {
    state.pr = PR;
  }
  const comment = JSON.parse(reply.stdout ?? "{}");
  comment.body = `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
  fx.fakeGh.reply([
    { ...reply, stdout: JSON.stringify(comment) },
    historyReply(n),
    {
      when: `pr view ${PR}`,
      stdout: JSON.stringify({
        number: PR,
        state: "MERGED",
        mergeCommit: { oid: "a".repeat(FULL_SHA_LENGTH) },
        headRefOid: state.headSha,
      }),
    },
  ]);
  return JSON.parse(fx.ask({ op: "pin-wiki", number: n }, config));
}

test("pinning commits only the final wiki result, is idempotent and does not push before verification", () => {
  const n = 91;
  const { wt, integrated } = branch(n);
  const remote = fx.originRef(`agent/issue-${n}`);
  const reply = ask(n);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.changed, true);
  assert.equal(pinAt(wt, "HEAD"), integrated);
  assert.equal(fx.sh(`git -C ${wt} diff --name-only HEAD~1 HEAD`), "wiki");
  assert.equal(fx.originRef(`agent/issue-${n}`), remote);
  assert.equal(ask(n).changed, false);
});

for (const denied of ["saved-merge", "attempted-merge", "wiki-only"]) {
  test(`pinning refuses ${denied} without touching the code index or head`, () => {
    const n =
      { "saved-merge": 92, "attempted-merge": 93, "wiki-only": 94 }[denied] ??
      0;
    const { wt, before, pin } = branch(n);
    /** @type {Partial<import("../src/state.ts").IssueState>} */
    let patch = { flows: { code: false, wiki: true } };
    if (denied === "saved-merge") {
      patch = { codeMerged: { pr: PR, sha: before.head } };
    }
    if (denied === "attempted-merge") {
      const revision = { code: before.head, wiki: pin, inputs: "trusted" };
      patch = {
        mergeAttempt: {
          repo: "o/r",
          pr: PR,
          target: "integration",
          branch: `agent/issue-${n}`,
          authorized: revision,
          hardened: revision,
          integration: null,
          result: null,
          reads: 0,
        },
      };
    }
    const reply = ask(n, patch);
    assert.equal(reply.ok, false);
    assert.deepEqual(fx.worktreeState(n), before);
    assert.equal(fx.sh(`git -C ${wt} diff --cached --name-only`), "");
    assert.equal(pinAt(wt, "HEAD"), pin);
  });
}

test("dirty wiki content cannot be pinned as an integrated result", () => {
  const n = 95;
  const { wt, before } = branch(n);
  fs.writeFileSync(path.join(wt, "wiki", "Home.md"), "uncommitted intent\n");
  const reply = ask(n);
  assert.equal(reply.ok, false);
  assert.equal(fx.worktreeState(n).head, before.head);
  assert.equal(fx.sh(`git -C ${wt} diff --cached --name-only`), "");
});

test("a freshly observed code merge closes pin writes before touching the index", () => {
  const n = 96;
  const { wt, before } = branch(n);
  const reply = ask(n, {}, true);
  assert.equal(reply.ok, false);
  assert.deepEqual(fx.worktreeState(n), before);
  assert.equal(fx.sh(`git -C ${wt} diff --cached --name-only`), "");
});
