// @ts-check
// sync-base, finish-sync and push on a branch whose commits move the wiki pin
// and put it back, with the wiki checkout ahead of the pin (#458). Replaying
// those commits drops the gitlink's assume-unchanged mark; the moved wiki
// checkout still never counts as an uncommitted change and is never
// committed. Through the ops CLI against local origins and the fake gh.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { opsFixture } from "./ops-fixture.mjs";
import {
  addWiki,
  movePin,
  movePinAndBack,
  pinAt,
  resetAcrossPin,
  statusOf,
  wikiAhead,
} from "./wiki-pin-test-kit.mjs";

const fx = await opsFixture("sync-wiki-pin");
const { sh, worktree } = fx;
const { loadConfig } = await import("../src/config.ts");
const { ensureWiki } = await import("../src/wiki.ts");
const { ensureClone, ensureWorktree } = await import("../src/checkouts.ts");

addWiki(fx);
const config = fx.configWith("wiki-config.json", { wiki: true });
const cfg = loadConfig(config);
ensureClone(cfg);
const origin = path.join(fx.root, "origin.git");

// One issue per test, so no test sees another's branch.
const ISSUE = {
  pinBeforeStop: 61,
  pinAfterStop: 62,
  clean: 63,
  twoStops: 64,
  fixCommit: 65,
  pinCommitted: 66,
  pinMoved: 67,
};
const MOVED_PIN = /the head pins wiki commit [0-9a-f]+, not [0-9a-f]+/u;
// The commits a resolver makes itself, as the stage path's does.
const RESOLVER = "-c user.name=Seed -c user.email=seed@example.com";

// The parts of sync-base's, finish-sync's and push's replies the tests read.
const SYNC_REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  changed: z.boolean().optional(),
  conflict: z.boolean().optional(),
  inRebase: z.boolean().optional(),
  resolved: z.boolean().optional(),
  reason: z.string().optional(),
});

/** @param {object} request @returns {z.infer<typeof SYNC_REPLY>} the op's parsed reply */
function ask(request) {
  fx.fakeGh.reply([]);
  return SYNC_REPLY.parse(JSON.parse(fx.ask(request, config)));
}

/**
 * Issue `n`'s branch on the base, its wiki checkout one commit ahead of the
 * pin: `steps` in order, each "pin" (move the pin and put it back), "move"
 * (move it on purpose) or a file to commit with "mine", pushed.
 * @param {number} n
 * @param {readonly string[]} steps
 * @returns {{ wt: string, wikiHead: string }}
 */
function branchWith(n, steps) {
  fx.fetchClone();
  ensureWorktree(cfg, n);
  ensureWiki(cfg, n);
  const wt = worktree(n);
  const wikiHead = wikiAhead(wt, `W${n}`);
  for (const step of steps) {
    if (step === "pin") {
      movePinAndBack(wt);
    } else if (step === "move") {
      movePin(wt);
    } else {
      fx.commitIn(n, step, "mine");
    }
  }
  fx.pushFrom(n);
  return { wt, wikiHead };
}

/**
 * Resolves the stopped commit's `file` and continues the rebase, staging
 * with -A; with `stopsAgain`, a later commit is expected to stop it.
 * @param {string} wt @param {string} file @param {boolean} [stopsAgain]
 * @returns {void}
 */
function resolveAndContinue(wt, file, stopsAgain = false) {
  fs.writeFileSync(path.join(wt, file), "resolved\n");
  const go = "GIT_EDITOR=true git rebase --continue";
  let cont = go;
  if (stopsAgain) {
    cont = `{ ${go} >/dev/null 2>&1 || true; }`;
  }
  sh(`cd ${wt} && git add -A && ${cont}`);
}

/** @param {string} wt @param {string} file commits a new `file` after the rebase, staging with -A, as the resolver's post-rebase fix does */
function fixCommit(wt, file) {
  fs.writeFileSync(path.join(wt, file), "fix\n");
  sh(`cd ${wt} && git add -A && git ${RESOLVER} commit -qm fix`);
}

/** @param {number} n @returns {string} the wiki commit #n's branch on origin pins */
function pushedPin(n) {
  return pinAt(origin, `agent/issue-${n}`);
}

test("a kept conflict after commits that move the wiki pin and put it back shows only the conflict, and finish-sync pushes the base's pin", () => {
  const n = ISSUE.pinBeforeStop;
  const file = `g${n}`;
  const { wt, wikiHead } = branchWith(n, ["pin", file]);
  fx.advanceBase(file, "theirs");
  const sync = ask({ op: "sync-base", number: n, keepConflict: true });
  assert.equal(sync.conflict, true);
  assert.equal(sync.inRebase, true);
  assert.equal(statusOf(wt), `AA ${file}`);
  resolveAndContinue(wt, file);
  const finish = ask({ op: "finish-sync", number: n });
  assert.equal(finish.resolved, true, finish.reason);
  assert.equal(pushedPin(n), pinAt(origin, "integration"));
  assert.equal(sh(`git -C ${wt}/wiki rev-parse HEAD`), wikiHead);
});

test("finish-sync pushes a rebase the resolver continued itself past commits that move the wiki pin", () => {
  const n = ISSUE.pinAfterStop;
  const file = `g${n}`;
  const { wt, wikiHead } = branchWith(n, [file, "pin"]);
  fx.advanceBase(file, "theirs");
  const sync = ask({ op: "sync-base", number: n, keepConflict: true });
  assert.equal(sync.inRebase, true);
  resolveAndContinue(wt, file);
  const finish = ask({ op: "finish-sync", number: n });
  assert.equal(finish.resolved, true, finish.reason);
  assert.equal(pushedPin(n), pinAt(origin, "integration"));
  assert.equal(statusOf(wt), "");
  assert.equal(sh(`git -C ${wt}/wiki rev-parse HEAD`), wikiHead);
});

test("a clean sync-base past commits that move the wiki pin leaves the checkout clean, and a push after a writer's own reset across them succeeds", () => {
  const n = ISSUE.clean;
  const { wt } = branchWith(n, [`own${n}`, "pin"]);
  fx.advanceBase(`b${n}`, "base");
  const sync = ask({ op: "sync-base", number: n });
  assert.equal(sync.changed, true, sync.error);
  assert.equal(statusOf(wt), "");
  resetAcrossPin(wt);
  const pushed = ask({ op: "push", number: n });
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(pushedPin(n), pinAt(origin, "integration"));
});

test("a resolver's add -A at a second stop, after the pin commits replay, commits no wiki pin", () => {
  const n = ISSUE.twoStops;
  const [first, second] = [`g${n}`, `h${n}`];
  const { wt, wikiHead } = branchWith(n, [first, "pin", second]);
  fx.advanceBase(first, "theirs");
  fx.advanceBase(second, "theirs");
  const sync = ask({ op: "sync-base", number: n, keepConflict: true });
  assert.equal(sync.inRebase, true);
  resolveAndContinue(wt, first, true);
  assert.equal(statusOf(wt), `AA ${second}`);
  resolveAndContinue(wt, second);
  const finish = ask({ op: "finish-sync", number: n });
  assert.equal(finish.resolved, true, finish.reason);
  assert.equal(pushedPin(n), pinAt(origin, "integration"));
  assert.equal(sh(`git -C ${wt}/wiki rev-parse HEAD`), wikiHead);
});

test("a resolver's add -A commit after its continue past the pin commits commits no wiki pin", () => {
  const n = ISSUE.fixCommit;
  const file = `g${n}`;
  const { wt } = branchWith(n, [file, "pin"]);
  fx.advanceBase(file, "theirs");
  ask({ op: "sync-base", number: n, keepConflict: true });
  resolveAndContinue(wt, file);
  fixCommit(wt, `fix${n}`);
  const finish = ask({ op: "finish-sync", number: n });
  assert.equal(finish.resolved, true, finish.reason);
  assert.equal(pushedPin(n), pinAt(origin, "integration"));
});

test("finish-sync rejects a head that pins the wiki checkout's moved head, and pushes nothing", () => {
  const n = ISSUE.pinCommitted;
  const file = `g${n}`;
  const { wt } = branchWith(n, [file]);
  const before = fx.originRef(`agent/issue-${n}`);
  fx.advanceBase(file, "theirs");
  ask({ op: "sync-base", number: n, keepConflict: true });
  sh(`cd ${wt} && git update-index --no-assume-unchanged -- wiki`);
  resolveAndContinue(wt, file);
  const finish = ask({ op: "finish-sync", number: n });
  assert.equal(finish.resolved, false);
  assert.match(finish.reason ?? "", MOVED_PIN);
  assert.equal(fx.originRef(`agent/issue-${n}`), before);
});

test("finish-sync keeps a wiki pin the branch's own commits move on purpose", () => {
  const n = ISSUE.pinMoved;
  const file = `g${n}`;
  const { wt, wikiHead } = branchWith(n, ["move", file]);
  fx.advanceBase(file, "theirs");
  ask({ op: "sync-base", number: n, keepConflict: true });
  resolveAndContinue(wt, file);
  const finish = ask({ op: "finish-sync", number: n });
  assert.equal(finish.resolved, true, finish.reason);
  assert.equal(pushedPin(n), wikiHead);
});
