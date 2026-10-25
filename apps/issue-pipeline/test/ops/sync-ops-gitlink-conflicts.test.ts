// A rebase that conflicts on a gitlink, through the real ops with no
// initialized submodule, stops on it: the error names the gitlink and each of
// its numbered stages, the rebase and its unmerged index are kept, and
// nothing is pushed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { OpsFixture } from "../ops-fixtures.ts";
import type { GitlinkSyncFixture } from "./gitlink-sync-test-kit.ts";
import { gitlinkSyncFixture } from "./gitlink-sync-test-kit.ts";

const {
  fx,
  seed,
  vendorBase,
  vendorOrigin,
  branch,
  vendorCommit,
  stagePin,
  ask,
  unmerged,
  resolveText,
}: GitlinkSyncFixture = await gitlinkSyncFixture("gitlink-conflicts");
const { sh }: OpsFixture = fx;

// Each unmerged index line of `stages` the error doesn't name, by its stage,
// commit and mode.
function stagesNotNamed(error: string | undefined, stages: string): string[] {
  return stages.split("\n").filter((line) => {
    const [mode, sha, numbered] = line.split(" ");
    const stage = numbered?.split("\t")[0];
    return !error?.includes(`stage ${stage}: ${sha} (mode ${mode})`);
  });
}

// Issue `n`'s branch on origin and whether any gh call posted.
function published(n: number): { remote: string; posted: boolean } {
  return {
    remote: fx.originRef(`agent/issue-${n}`),
    posted: fx.fakeGh.calls().some((args) => args.includes("POST")),
  };
}

test("a gitlink conflict stops with every numbered stage and no synchronized push", () => {
  const n = 73;
  const wt = branch(n);
  assert.equal(fs.existsSync(path.join(wt, "vendor", ".git")), false);
  const own = vendorCommit("own73");
  stagePin(wt, own);
  fx.commitIn(n, "own73", "mine");
  const before = fx.pushFrom(n);
  const target = vendorCommit("target73");
  stagePin(seed, target);
  fx.advanceBase("base73", "target");
  const reply = ask(n, "sync-base");
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes('"vendor"'), reply.error);
  for (const [index, sha] of [vendorBase, target, own].entries()) {
    const stage = index + 1;
    assert.ok(reply.error?.includes(`stage ${stage}: ${sha}`), reply.error);
    assert.ok(unmerged(wt).includes(`160000 ${sha} ${stage}\tvendor`));
  }
  assert.equal(fx.inRebase(n), true);
  assert.deepEqual(published(n), { remote: before, posted: false });
});

test("a gitlink versus ordinary file type conflict is retained, never auto-selected", () => {
  const n = 78;
  const wt = branch(n);
  sh(`git -C ${wt} rm -q --cached vendor`);
  fs.rmSync(path.join(wt, "vendor"), { recursive: true, force: true });
  fs.writeFileSync(path.join(wt, "vendor"), "ordinary file intent\n");
  sh(`git -C ${wt} add vendor`);
  fx.commitIn(n, "own78", "mine");
  const before = fx.pushFrom(n);
  stagePin(seed, vendorCommit("target78"));
  fx.advanceBase("base78", "target");
  const reply = ask(n, "sync-base");
  assert.equal(reply.ok, false);
  assert.ok(typeof reply.error === "string");
  assert.ok(reply.error.includes("vendor"), reply.error);
  assert.ok(reply.error.includes("mode 160000"), reply.error);
  assert.equal(fx.inRebase(n), true);
  assert.notEqual(unmerged(wt), "");
  assert.deepEqual(published(n), { remote: before, posted: false });
});

test("two conflicting gitlinks both keep every stage", () => {
  const otherBase = vendorCommit("zzbase");
  stagePin(seed, otherBase, "zz-vendor");
  fs.appendFileSync(
    path.join(seed, ".gitmodules"),
    `\n[submodule "zz-vendor"]\n  path = zz-vendor\n  url = ${vendorOrigin}\n`,
  );
  sh(`git -C ${seed} add .gitmodules`);
  fx.advanceBase("zz-seed", "seed");
  const n = 79;
  const wt = branch(n);
  const start = sh(`git -C ${wt} rev-parse HEAD:vendor`);
  const own = { vendor: vendorCommit("own79"), zz: vendorCommit("zzown79") };
  stagePin(wt, own.vendor);
  stagePin(wt, own.zz, "zz-vendor");
  fx.commitIn(n, "own79", "mine");
  const before = fx.pushFrom(n);
  const target = {
    vendor: vendorCommit("target79"),
    zz: vendorCommit("zztarget79"),
  };
  stagePin(seed, target.vendor);
  stagePin(seed, target.zz, "zz-vendor");
  fx.advanceBase("base79", "target");
  const reply = ask(n, "sync-base");
  assert.equal(reply.ok, false);
  for (const { file, pins } of [
    { file: "vendor", pins: [start, target.vendor, own.vendor] },
    { file: "zz-vendor", pins: [otherBase, target.zz, own.zz] },
  ]) {
    for (const [index, sha] of pins.entries()) {
      const stage = index + 1;
      assert.ok(unmerged(wt).includes(`160000 ${sha} ${stage}\t${file}`));
    }
  }
  assert.equal(fx.inRebase(n), true);
  assert.deepEqual(published(n), { remote: before, posted: false });
});

test("abort after a session continued the rebase into a later gitlink stop retains it and names all its stages", () => {
  const n = 93;
  const wt = branch(n);
  fx.commitIn(n, `early${n}`, "mine");
  stagePin(wt, vendorCommit(`own${n}`));
  fx.commitIn(n, `later${n}`, "mine");
  const original = fx.pushFrom(n);
  stagePin(seed, vendorCommit(`target${n}`));
  const base = fx.advanceBase(`early${n}`, "target");
  const first = ask(n, "sync-base");
  assert.deepEqual(first.conflicts, [`early${n}`]);
  resolveText(wt, `early${n}`);
  const continued = spawnSync(
    "git",
    ["-C", wt, "-c", "core.editor=true", "rebase", "--continue"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(continued.status, 1);
  assert.equal(fx.inRebase(n), true);
  const stages = unmerged(wt);
  assert.ok(stages.includes("\tvendor"), stages);
  const reply = ask(n, "finish-sync", { baseSha: base, abort: true });
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes('"vendor"'), reply.error);
  assert.deepEqual(stagesNotNamed(reply.error, stages), []);
  assert.equal(unmerged(wt), stages);
  assert.equal(fx.inRebase(n), true);
  assert.deepEqual(published(n), { remote: original, posted: false });
});
