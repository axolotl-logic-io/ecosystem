// A target moves after real Implement. Sync must produce code containing the
// new target before fresh Harden can attest it. Built buddy/ops, Git, ledger
// and model commit boundary are real; only GitHub and model transports fake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { TaskId } from "../../src/domain.ts";
import type { Result } from "../../src/tasks/records.ts";
import { RECORD } from "../../src/tasks/records.ts";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const BRANCH = `agent/issue-${ISSUE}`;
const RAW_CONFIG = z.record(z.string(), z.unknown());
const COUNTS: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets\n",
    message: "Count widgets before the target moves",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};
const HARDEN: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Reviewed the synchronized revision." },
};

function select(box: Machine, responsibilities: TaskId[]): void {
  const file = path.join(box.root, "buddy.json");
  const original = RAW_CONFIG.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(file, JSON.stringify({ ...original, responsibilities }));
}

function results(box: Machine): Result[] {
  return marked(box.world(), "task-result")
    .map((item) => RECORD.parse(item))
    .filter((item): item is Result => item.kind === "result");
}

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

test("a moved target needs Sync before fresh Harden, with no replay of passed work", async () => {
  const box = machine();
  let complete = false;
  try {
    const initialTarget = box.git(["rev-parse", "main"]);
    const implemented = await box.runBuddy([COUNTS], 2);
    assert.equal(implemented.status, 0, implemented.stderr);
    assert.equal(implemented.actions.length, 1);
    assert.equal(implemented.actions[0]?.verdict, "passed");
    const originalCode = box.git(["rev-parse", BRANCH]);
    assert.equal(box.git(["rev-parse", "main"]), initialTarget);
    assert.deepEqual(
      results(box).map((item) => item.binding.task),
      ["implement"],
    );

    // An unrelated upstream change is a real new target, not a fabricated
    // task result. It does not grant a second Implement of these requirements.
    fs.writeFileSync(path.join(box.work, "upstream.txt"), "upstream change\n");
    git(box.work, ["add", "upstream.txt"]);
    git(box.work, ["commit", "--quiet", "-m", "Advance the target"]);
    git(box.work, ["push", "--quiet", "origin", "main"]);
    const target = box.git(["rev-parse", "main"]);
    assert.notEqual(target, initialTarget);
    assert.notEqual(box.git(["merge-base", originalCode, target]), target);

    select(box, ["sync"]);
    const synced = await box.runBuddy([], 2);
    assert.equal(synced.status, 0, synced.stderr);
    const syncActions = synced.actions.filter((item) => item.task === "sync");
    assert.equal(syncActions.length, 1, JSON.stringify(syncActions, null, 2));
    assert.equal(syncActions[0]?.verdict, "passed");
    assert.equal(syncActions[0]?.ownership.state, "released");
    assert.equal(syncActions[0]?.sessions.length, 0);
    const code = box.git(["rev-parse", BRANCH]);
    assert.notEqual(code, originalCode);
    assert.equal(box.git(["merge-base", target, code]), target);
    assert.equal(box.git(["show", `${code}:counter.txt`]), "3 widgets");
    assert.equal(box.git(["show", `${code}:upstream.txt`]), "upstream change");
    assert.equal(box.git(["rev-parse", "main"]), target);
    const syncResult = results(box).find(
      (item) => item.binding.task === "sync",
    );
    assert.ok(syncResult !== undefined);
    assert.equal(syncResult.verdict, "passed");
    assert.ok("revision" in syncResult.binding);
    assert.equal(syncResult.binding.revision.code, originalCode);
    assert.equal(syncResult.binding.target.commit, target);
    assert.equal(syncResult.receipt.produced?.code, code);
    assert.deepEqual(
      results(box).map((item) => item.binding.task),
      ["implement", "sync"],
    );
    assert.equal(box.launches().length, 1);

    // Already-containing code needs no second rebase, attempt or model.
    const beforeRepeatSync = marked(box.world(), "task-result");
    const repeatedSync = await box.runBuddy([], 2);
    assert.equal(repeatedSync.status, 0, repeatedSync.stderr);
    assert.equal(repeatedSync.actions.length, synced.actions.length);
    assert.deepEqual(marked(box.world(), "task-result"), beforeRepeatSync);
    assert.equal(box.git(["rev-parse", BRANCH]), code);

    select(box, ["harden"]);
    const hardened = await box.runBuddy([HARDEN], 2);
    assert.equal(hardened.status, 0, hardened.stderr);
    const hardenActions = hardened.actions.filter(
      (item) => item.task === "harden",
    );
    assert.equal(hardenActions.length, 1);
    assert.equal(hardenActions[0]?.verdict, "passed");
    assert.equal(hardenActions[0]?.ownership.state, "released");
    assert.equal(box.launches().length, 2);
    const hardenResult = results(box).find(
      (item) => item.binding.task === "harden",
    );
    assert.ok(hardenResult !== undefined);
    assert.equal(hardenResult.verdict, "passed");
    assert.ok("revision" in hardenResult.binding);
    assert.equal(hardenResult.binding.revision.code, code);
    assert.equal(hardenResult.binding.target.commit, target);
    assert.equal(box.git(["rev-parse", "main"]), target);
    const beforeRepeatHarden = marked(box.world(), "task-result");
    const repeatedHarden = await box.runBuddy([], 2);
    assert.equal(repeatedHarden.status, 0, repeatedHarden.stderr);
    assert.equal(repeatedHarden.actions.length, hardened.actions.length);
    assert.deepEqual(marked(box.world(), "task-result"), beforeRepeatHarden);
    assert.equal(box.launches().length, 2);
    complete = true;
  } finally {
    if (complete) {
      box.cleanup();
    } else {
      process.stderr.write(`Sync flow evidence retained at ${box.root}\n`);
    }
  }
});
