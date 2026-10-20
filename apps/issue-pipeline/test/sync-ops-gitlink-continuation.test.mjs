// @ts-check
// Real divergent gitlinks through ops, with no initialized code submodule.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { gitlinkSyncFixture } from "./gitlink-sync-test-kit.mjs";
import { pinAt } from "./wiki-pin-test-kit.mjs";

const {
  fx,
  seed,
  wikiSeed,
  branch,
  wikiCommit,
  stagePin,
  ask,
  unmerged,
  resolveText,
} = await gitlinkSyncFixture("gitlink-continuation");
const { sh } = fx;

test("a text-only stop followed by a wiki-only stop finishes in one deterministic continuation", () => {
  const n = 77;
  const wt = branch(n);
  fx.commitIn(n, "text77", "mine");
  const own = wikiCommit("own77");
  stagePin(wt, own);
  sh(`git -C ${wt} commit -qm "Private wiki pin only"`);
  const original = fx.pushFrom(n);
  const target = wikiCommit("target77");
  stagePin(seed, target);
  const base = fx.advanceBase("text77", "target");
  const first = ask(n, "sync-base");
  assert.deepEqual(first.conflicts, ["text77"]);
  assert.equal(fx.originRef(`agent/issue-${n}`), original);
  resolveText(wt, "text77");
  const finished = ask(n, "finish-sync", { baseSha: base });
  assert.equal(finished.resolved, true, finished.reason ?? finished.error);
  assert.equal(fx.inRebase(n), false);
  assert.equal(unmerged(wt), "");
  assert.equal(pinAt(wt, "HEAD"), target);
  assert.equal(
    pinAt(path.join(fx.root, "origin.git"), `agent/issue-${n}`),
    target,
  );
  assert.equal(
    fs.readFileSync(path.join(wt, "text77"), "utf8"),
    "both intents\n",
  );
  assert.equal(sh(`git -C ${wikiSeed} rev-parse origin/own77`), own);
  assert.equal(sh(`git -C ${wikiSeed} rev-parse origin/target77`), target);
});

test("an unsupported gitlink retains every conflict stage, including an otherwise eligible wiki conflict", () => {
  const vendorBase = wikiCommit("mixedvendorbase");
  stagePin(seed, vendorBase, "zz-vendor");
  fs.appendFileSync(
    path.join(seed, ".gitmodules"),
    `\n[submodule "zz-vendor"]\n  path = zz-vendor\n  url = ${path.join(fx.root, "wiki.git")}\n`,
  );
  sh(`git -C ${seed} add .gitmodules`);
  fx.advanceBase("mixed-seed", "seed");
  const n = 79;
  const wt = branch(n);
  const wikiStart = pinAt(wt, "HEAD");
  const ownWiki = wikiCommit("mixedownwiki");
  const ownVendor = wikiCommit("mixedownvendor");
  stagePin(wt, ownWiki);
  stagePin(wt, ownVendor, "zz-vendor");
  fx.commitIn(n, "own79", "mine");
  const before = fx.pushFrom(n);
  const targetWiki = wikiCommit("mixedtargetwiki");
  const targetVendor = wikiCommit("mixedtargetvendor");
  stagePin(seed, targetWiki);
  stagePin(seed, targetVendor, "zz-vendor");
  fx.advanceBase("base79", "target");
  const reply = ask(n, "sync-base");
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes('"zz-vendor"'), reply.error);
  for (const { file, pins } of [
    { file: "wiki", pins: [wikiStart, targetWiki, ownWiki] },
    { file: "zz-vendor", pins: [vendorBase, targetVendor, ownVendor] },
  ]) {
    for (const [index, sha] of pins.entries()) {
      const stage = index + 1;
      assert.ok(unmerged(wt).includes(`160000 ${sha} ${stage}\t${file}`));
    }
  }
  for (const [index, sha] of [vendorBase, targetVendor, ownVendor].entries()) {
    assert.ok(reply.error?.includes(`stage ${index + 1}: ${sha}`), reply.error);
  }
  assert.equal(fx.inRebase(n), true);
  assert.equal(fx.originRef(`agent/issue-${n}`), before);
  assert.equal(
    fx.fakeGh.calls().some((args) => args.includes("POST")),
    false,
  );
});
