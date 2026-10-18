// @ts-check
// verify, start-pr and cleanup's unsaved-work check in a checkout whose
// wiki gitlink lost its assume-unchanged mark, as a writer's own reset
// across commits that move the pin drops it, with the wiki checkout ahead
// of the pin (#458). The moved wiki checkout never counts as an uncommitted
// change. Through the ops CLI against local origins and the fake gh.
import assert from "node:assert/strict";
import { test } from "node:test";
import { opsFixture } from "./ops-fixture.mjs";
import {
  addWiki,
  movePinAndBack,
  resetAcrossPin,
  statusOf,
  wikiAhead,
} from "./wiki-pin-test-kit.mjs";

const fx = await opsFixture("wiki-pin-held");
const { loadConfig } = await import("../src/config.ts");
const { ensureWiki } = await import("../src/wiki.ts");
const { ensureClone, ensureWorktree, unsavedWork } = await import(
  "../src/checkouts.ts"
);

addWiki(fx);
const config = fx.configWith("wiki-config.json", { wiki: true });
const cfg = loadConfig(config);
ensureClone(cfg);

// One issue per test, so no test sees another's branch.
const ISSUE = { verify: 81, cleanup: 82, startPr: 83 };
const PR = 183;
// `git status --porcelain`, trimmed, of a moved wiki checkout.
const MOVED_WIKI = "M wiki";

/** @param {object} request @param {import("./fake-gh.mjs").GhReply[]} [replies] @returns {any} the op's parsed reply */
function ask(request, replies = []) {
  fx.fakeGh.reply(replies);
  return JSON.parse(fx.ask(request, config));
}

/**
 * Issue `n`'s worktree with its wiki checkout one commit ahead of the pin.
 * @param {number} n @returns {string} the worktree
 */
function worktreeAhead(n) {
  fx.fetchClone();
  ensureWorktree(cfg, n);
  ensureWiki(cfg, n);
  const wt = fx.worktree(n);
  wikiAhead(wt, `W${n}`);
  return wt;
}

/**
 * Issue `n`'s branch, pushed: a file, then commits that move the wiki pin
 * and put it back; then a reset across them drops the gitlink's mark.
 * @param {number} n @returns {string} the worktree
 */
function pushedBranchUnheld(n) {
  const wt = worktreeAhead(n);
  fx.commitIn(n, `own${n}`, "mine");
  movePinAndBack(wt);
  fx.pushFrom(n);
  resetAcrossPin(wt);
  return wt;
}

test("verify passes the tests in a checkout whose wiki gitlink lost its mark", () => {
  const n = ISSUE.verify;
  assert.equal(statusOf(pushedBranchUnheld(n)), MOVED_WIKI);
  const reply = ask({ op: "verify", number: n, testsOnly: true });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.pass, true, JSON.stringify(reply.checks));
});

test("cleanup's unsaved-work check finds none in a pushed checkout whose wiki gitlink lost its mark", () => {
  const n = ISSUE.cleanup;
  assert.equal(statusOf(pushedBranchUnheld(n)), MOVED_WIKI);
  assert.equal(unsavedWork(cfg, n, null), null);
});

test("start-pr opens a new branch's draft from a checkout whose wiki gitlink lost its mark", () => {
  const n = ISSUE.startPr;
  const wt = worktreeAhead(n);
  fx.sh(`git -C ${wt} update-index --no-assume-unchanged -- wiki`);
  assert.equal(statusOf(wt), MOVED_WIKI);
  const reply = ask({ op: "start-pr", number: n }, [
    // start-pr first reads the saved state: no comments, so no codeMerged.
    { when: `issues/${n}/comments`, stdout: "" },
    { when: `repos/o/r/issues/${n}`, stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${PR}\n` },
  ]);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.pr, PR);
});
