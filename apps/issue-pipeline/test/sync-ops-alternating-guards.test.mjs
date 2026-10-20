// @ts-check
// Alternating stops must keep exact-target and recovery safeguards at the boundary.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fixture, history, syncContext } from "./alternating-sync-test-kit.mjs";
import { pinAt } from "./wiki-pin-test-kit.mjs";

const { fx, ask, resolveText, stagePin, seed, wikiCommit, unmerged } = fixture;
const ISSUE = { target: 111, evidence: 112, movingBase: 113, markers: 114 };
/** @typedef {import("./alternating-sync-test-kit.mjs").History} History */

/** @param {number} n */
function laterStop(n) {
  const h = history(n, ["text", "wiki", "text"]);
  const first = ask(n, "sync-base");
  resolveText(h.wt, `text${n}-0`);
  const next = ask(n, "finish-sync", { baseSha: h.base });
  return { h, stops: [first.conflicts, next.conflicts] };
}

/** @param {History} h */
function snapshot(h) {
  const index = path.resolve(
    h.wt,
    fx.sh(`git -C ${h.wt} rev-parse --git-path index`),
  );
  return {
    index: fs.readFileSync(index),
    context: syncContext(h.wt),
    text: fs.readFileSync(path.join(h.wt, `text${h.n}-2`)),
    stages: unmerged(h.wt),
    pick: fx.sh(`git -C ${h.wt} rev-parse REBASE_HEAD`),
    rebasing: fx.inRebase(h.n),
    remote: fx.originRef(`agent/issue-${h.n}`),
  };
}

/** @param {History} h @returns {string} */
function recoveryDir(h) {
  return path.join(fx.root, "runs", "o__r", `issue-${h.n}`, "recovery");
}

test("retention refuses a different target before changing the later stopped pick or creating evidence", () => {
  const { h, stops } = laterStop(ISSUE.target);
  assert.deepEqual(stops, [[`text${h.n}-0`], [`text${h.n}-2`]]);
  const before = snapshot(h);
  const reply = ask(h.n, "finish-sync", {
    retainConflict: true,
    baseSha: h.original,
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.retained, undefined);
  assert.ok(reply.error?.includes("target differs"), reply.error);
  assert.deepEqual(snapshot(h), before);
  assert.equal(fs.existsSync(recoveryDir(h)), false);
});

test("a real recovery write failure retains the exact unresolved checkout without claiming retention succeeded", () => {
  const { h, stops } = laterStop(ISSUE.evidence);
  assert.deepEqual(stops, [[`text${h.n}-0`], [`text${h.n}-2`]]);
  const before = snapshot(h);
  const recovery = recoveryDir(h);
  fs.mkdirSync(path.dirname(recovery), { recursive: true });
  fs.writeFileSync(recovery, "existing evidence must not be overwritten\n");
  const reply = ask(h.n, "finish-sync", {
    retainConflict: true,
    baseSha: h.base,
    reason: "maxConflictFixes exhausted",
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.retained, undefined);
  assert.deepEqual(snapshot(h), before);
  assert.equal(
    fs.readFileSync(recovery, "utf8"),
    "existing evidence must not be overwritten\n",
  );
});

test("a base and wiki pin moving between text sessions cannot replace the recorded synchronization target", () => {
  const { h, stops } = laterStop(ISSUE.movingBase);
  assert.deepEqual(stops, [[`text${h.n}-0`], [`text${h.n}-2`]]);
  const newPin = wikiCommit(`moving${h.n}`);
  stagePin(seed, newPin);
  const newBase = fx.advanceBase(`moving-base${h.n}`, "new target");
  fx.sh(`git -C ${h.wt} fetch -q origin integration`);
  assert.notEqual(newBase, h.base);
  assert.notEqual(newPin, h.target);
  resolveText(h.wt, `text${h.n}-2`);
  const reply = ask(h.n, "finish-sync", { baseSha: h.base });
  assert.equal(reply.resolved, true, reply.reason ?? reply.error);
  assert.equal(fx.inRebase(h.n), false);
  assert.equal(pinAt(h.wt, "HEAD"), h.target);
  assert.equal(pinAt(h.wt, "origin/integration"), newPin);
  const pushed = fx.originRef(`agent/issue-${h.n}`);
  assert.equal(fx.sh(`git -C ${h.wt} rev-parse HEAD`), pushed);
  assert.equal(pinAt(path.join(fx.root, "origin.git"), pushed), h.target);
  assert.equal(fx.sh(`git -C ${h.wt} merge-base ${h.base} HEAD`), h.base);
  assert.notEqual(fx.sh(`git -C ${h.wt} merge-base ${newBase} HEAD`), newBase);
});

test("finishing alternating picks still rejects committed conflict markers and saves rejected work without pushing", () => {
  const { h, stops } = laterStop(ISSUE.markers);
  assert.deepEqual(stops, [[`text${h.n}-0`], [`text${h.n}-2`]]);
  const file = `text${h.n}-2`;
  const markers = "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n";
  fs.writeFileSync(path.join(h.wt, file), markers);
  fx.sh(`git -C ${h.wt} add -- ${file}`);
  const reply = ask(h.n, "finish-sync", { baseSha: h.base });
  assert.equal(reply.resolved, false);
  assert.ok(reply.reason?.includes("conflict markers remain"), reply.reason);
  assert.equal(fx.originRef(`agent/issue-${h.n}`), h.original);
  assert.equal(fx.inRebase(h.n), false);
  const recovery = recoveryDir(h);
  const entries = fs.readdirSync(recovery);
  assert.equal(entries.length, 1);
  const bundle = path.join(recovery, entries[0] ?? "missing", "commits.bundle");
  const restored = path.join(fx.root, `rejected${h.n}`);
  fx.sh(`git clone -q ${bundle} ${restored}`);
  fx.sh(`git -C ${restored} bundle verify ${bundle}`);
  assert.equal(fx.sh(`git -C ${restored} show HEAD:${file}`), markers.trim());
});
