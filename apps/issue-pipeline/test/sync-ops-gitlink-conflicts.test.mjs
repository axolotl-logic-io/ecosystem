// @ts-check
// Real divergent gitlinks through ops, with no initialized code submodule.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  historyReply,
  initialWriteStateReply,
} from "./initial-write-state-fixtures.mjs";
import { opsFixture } from "./ops-fixture.mjs";
import { addWiki, pinAt } from "./wiki-pin-test-kit.mjs";

const fx = await opsFixture("gitlink-conflicts");
fx.fakeGh.requireReplies();
addWiki(fx);
const config = fx.configWith("wiki.json", { wiki: true });
const disabled = fx.configWith("disabled.json", { wiki: false });
const { loadConfig } = await import("../src/config.ts");
const { ensureWorktree } = await import("../src/checkouts.ts");
const cfg = loadConfig(config);
const { sh, worktree } = fx;
const seed = path.join(fx.root, "seed");
const wikiSeed = path.join(fx.root, "wiki-seed");
const wikiBase = pinAt(seed, "HEAD");
const REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  conflict: z.boolean().optional(),
  conflicts: z.array(z.string()).optional(),
  changed: z.boolean().optional(),
  resolved: z.boolean().optional(),
  baseSha: z.string().optional(),
  reason: z.string().optional(),
});

/** @param {string} label @returns {string} */
function wikiCommit(label) {
  sh(`git -C ${wikiSeed} checkout -q --detach ${wikiBase}`);
  fs.writeFileSync(path.join(wikiSeed, `${label}.md`), `${label}\n`);
  sh(`git -C ${wikiSeed} add . && git -C ${wikiSeed} commit -qm ${label}`);
  const sha = sh(`git -C ${wikiSeed} rev-parse HEAD`);
  sh(`git -C ${wikiSeed} push -q origin HEAD:refs/heads/${label}`);
  return sha;
}

/** @param {string} wt @param {string} pin @param {string} [file] @returns {void} */
function stagePin(wt, pin, file = "wiki") {
  sh(`git -C ${wt} update-index --add --cacheinfo 160000,${pin},${file}`);
}

/** @param {number} n @returns {string} */
function branch(n) {
  fx.fetchClone();
  ensureWorktree(cfg, n);
  const wt = worktree(n);
  sh(`git -C ${wt} submodule deinit -q --force --all`);
  return wt;
}

/** @param {number} n @param {string} op @param {object} [extra] @param {string} [file] */
function ask(n, op, extra = {}, file = config) {
  fx.fakeGh.reply([initialWriteStateReply(n), historyReply(n)]);
  return REPLY.parse(
    JSON.parse(fx.ask({ op, number: n, keepConflict: true, ...extra }, file)),
  );
}

/** @param {string} wt @returns {string} */
function unmerged(wt) {
  return sh(`git -C ${wt} ls-files --unmerged`);
}

/** @param {string} wt @param {string} file @returns {void} */
function resolveText(wt, file) {
  fs.writeFileSync(path.join(wt, file), "both intents\n");
  sh(`git -C ${wt} add -- ${file}`);
}

test("a wiki-only conflict pins the exact fetched base and pushes without a resolver or wiki mutation", () => {
  const n = 71;
  const wt = branch(n);
  assert.equal(fs.existsSync(path.join(wt, "wiki", ".git")), false);
  const own = wikiCommit("own71");
  stagePin(wt, own);
  fx.commitIn(n, "own71", "code");
  fx.pushFrom(n);
  const other = wikiCommit("base71");
  stagePin(seed, other);
  const base = fx.advanceBase("base71", "other code");
  const reply = ask(n, "sync-base");
  assert.equal(reply.conflict, false, reply.error);
  assert.equal(reply.changed, true);
  assert.equal(unmerged(wt), "");
  assert.equal(pinAt(wt, "HEAD"), other);
  assert.equal(
    pinAt(path.join(fx.root, "origin.git"), `agent/issue-${n}`),
    other,
  );
  assert.equal(sh(`git -C ${wt} merge-base HEAD ${base}`), base);
  assert.equal(sh(`git -C ${wikiSeed} rev-parse origin/own71`), own);
  assert.equal(sh(`git -C ${wikiSeed} rev-parse origin/base71`), other);
});

test("machinery resolves wiki gitlinks at every later stop; finish accepts only its recorded base pin even after origin moves", () => {
  const n = 72;
  const wt = branch(n);
  const own = wikiCommit("own72");
  stagePin(wt, own);
  fx.commitIn(n, "text72", "mine");
  stagePin(wt, wikiCommit("later72"));
  fx.commitIn(n, "later72", "mine");
  const original = fx.pushFrom(n);
  const other = wikiCommit("base72");
  stagePin(seed, other);
  fx.advanceBase("text72", "target");
  const base = fx.advanceBase("later72", "target");
  const first = ask(n, "sync-base");
  assert.equal(first.baseSha, base);
  assert.deepEqual(first.conflicts, ["text72"]);
  assert.equal(sh(`git -C ${wt} rev-parse :wiki`), other);
  assert.equal(fx.originRef(`agent/issue-${n}`), original);
  resolveText(wt, "text72");
  const second = ask(n, "finish-sync", { baseSha: base });
  assert.deepEqual(second.conflicts, ["later72"]);
  assert.equal(sh(`git -C ${wt} rev-parse :wiki`), other);
  stagePin(seed, wikiCommit("newbase72"));
  fx.advanceBase("unrelated72", "base moved");
  sh(`git -C ${wt} fetch -q origin integration`);
  resolveText(wt, "later72");
  const finished = ask(n, "finish-sync", { baseSha: base });
  assert.equal(finished.resolved, true, finished.reason ?? finished.error);
  assert.equal(unmerged(wt), "");
  assert.equal(pinAt(wt, "HEAD"), other);
  assert.equal(
    pinAt(path.join(fx.root, "origin.git"), `agent/issue-${n}`),
    other,
  );
});

test("another gitlink stops precisely with full stage evidence and no synchronized push", () => {
  const base = wikiCommit("vendorbase");
  stagePin(seed, base, "vendor");
  fs.appendFileSync(
    path.join(seed, ".gitmodules"),
    `\n[submodule "vendor"]\n  path = vendor\n  url = ${path.join(fx.root, "wiki.git")}\n`,
  );
  sh(`git -C ${seed} add .gitmodules`);
  fx.advanceBase("vendor-seed", "seed");
  const n = 73;
  const wt = branch(n);
  const own = wikiCommit("vendorown");
  stagePin(wt, own, "vendor");
  fx.commitIn(n, "own73", "mine");
  const before = fx.pushFrom(n);
  const other = wikiCommit("vendortarget");
  stagePin(seed, other, "vendor");
  fx.advanceBase("base73", "target");
  const reply = ask(n, "sync-base");
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes('"vendor"'), reply.error);
  for (const [stage, sha] of [
    [1, base],
    [2, other],
    ["3", own],
  ]) {
    assert.ok(reply.error?.includes(`stage ${stage}: ${sha}`), reply.error);
    assert.ok(unmerged(wt).includes(`160000 ${sha} ${stage}\tvendor`));
  }
  assert.equal(fx.inRebase(n), true);
  assert.equal(fx.originRef(`agent/issue-${n}`), before);
  assert.equal(
    fx.fakeGh.calls().some((args) => args.includes("POST")),
    false,
  );
});

test("a disabled wiki flow does not auto-select even its wiki gitlink", () => {
  const n = 74;
  const wt = branch(n);
  stagePin(wt, wikiCommit("own74"));
  fx.commitIn(n, "own74", "mine");
  const before = fx.pushFrom(n);
  stagePin(seed, wikiCommit("base74"));
  fx.advanceBase("base74", "target");
  const reply = ask(n, "sync-base", {}, disabled);
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes('"wiki"'), reply.error);
  assert.notEqual(unmerged(wt), "");
  assert.equal(fx.originRef(`agent/issue-${n}`), before);
});

test("ordinary text at the configured wiki path remains a text conflict", () => {
  const n = 75;
  const wt = branch(n);
  fx.commitIn(n, "text75", "mine");
  fx.pushFrom(n);
  fx.advanceBase("text75", "target");
  const file = fx.configWith("text-path.json", { wiki: { dir: "text75" } });
  const reply = ask(n, "sync-base", {}, file);
  assert.deepEqual(reply.conflicts, ["text75"]);
  assert.ok(unmerged(wt).includes("100644"));
  assert.equal(fx.inRebase(n), true);
});

test("the configured nondefault gitlink gets the same exact-target policy", () => {
  sh(
    `git -C ${seed} mv wiki knowledge && git -C ${seed} commit -qm "Relocate wiki" && git -C ${seed} push -q origin integration`,
  );
  const file = fx.configWith("custom-path.json", {
    wiki: { dir: "knowledge" },
  });
  const n = 76;
  const wt = branch(n);
  stagePin(wt, wikiCommit("own76"), "knowledge");
  fx.commitIn(n, "own76", "mine");
  fx.pushFrom(n);
  const target = wikiCommit("target76");
  stagePin(seed, target, "knowledge");
  fx.advanceBase("base76", "target");
  const reply = ask(n, "sync-base", {}, file);
  assert.equal(reply.conflict, false, reply.error);
  assert.equal(unmerged(wt), "");
  assert.equal(sh(`git -C ${wt} rev-parse HEAD:knowledge`), target);
});

test("a wiki gitlink versus ordinary file type conflict is retained, never auto-selected", () => {
  const n = 78;
  const wt = branch(n);
  sh(`git -C ${wt} rm --cached knowledge`);
  fs.rmdirSync(path.join(wt, "knowledge"));
  fs.writeFileSync(path.join(wt, "knowledge"), "ordinary file intent\n");
  sh(`git -C ${wt} add knowledge`);
  fx.commitIn(n, "own78", "mine");
  fx.pushFrom(n);
  const remote = fx.originRef(`agent/issue-${n}`);
  stagePin(seed, wikiCommit("target78"), "knowledge");
  fx.advanceBase("base78", "target");
  const file = fx.configWith("type-path.json", { wiki: { dir: "knowledge" } });
  const reply = ask(n, "sync-base", {}, file);
  assert.equal(reply.ok, false);
  assert.ok(typeof reply.error === "string");
  assert.ok(reply.error.includes("unsupported gitlink conflict"), reply.error);
  assert.ok(reply.error.includes("knowledge"), reply.error);
  assert.ok(reply.error.includes("mode 160000"), reply.error);
  assert.equal(fx.inRebase(n), true);
  assert.notEqual(unmerged(wt), "");
  assert.equal(fx.originRef(`agent/issue-${n}`), remote);
});
