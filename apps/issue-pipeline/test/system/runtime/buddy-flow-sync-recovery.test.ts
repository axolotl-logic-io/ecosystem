// Real rebases and conflict preservation through the built buddy. Only the
// GitHub and model transports fake; recovery obtains its original attempt
// and branch effects from the tasks that actually ran in this test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { RECORD } from "../../../src/tasks/records.ts";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const IMPLEMENT: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "three widgets\n",
    message: "Count widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted widgets." },
};
const UNRESOLVED: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: {
    outcome: "done",
    summary: "Resolver returned without changing the index.",
  },
};
const IMPLEMENT_POLLS = 2;
const SYNC_POLLS = 3;
const RAW = z.record(z.string(), z.unknown());

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function selectSync(box: Machine): void {
  const file = path.join(box.root, "buddy.json");
  const original = RAW.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...original, responsibilities: ["sync"] }),
  );
}

function advance(box: Machine, file: string): string {
  fs.writeFileSync(path.join(box.work, file), "upstream count\n");
  git(box.work, ["add", file]);
  git(box.work, ["commit", "--quiet", "-m", "Advance target"]);
  git(box.work, ["push", "--quiet", "origin", "main"]);
  return box.git(["rev-parse", "refs/heads/main"]);
}

function keep(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
  } else {
    process.stderr.write(`Sync boundary evidence retained at ${box.root}\n`);
  }
}

test("Sync reconciles its own pushed revision without another attempt, model or push", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const implemented = await box.runBuddy(
      [IMPLEMENT],
      IMPLEMENT_POLLS,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    assert.equal(implemented.status, 0, implemented.stderr);
    assert.equal(implemented.actions[0]?.verdict, "passed");
    const from = box.git(["rev-parse", `refs/heads/agent/issue-${ISSUE}`]);
    const target = advance(box, "upstream.txt");
    selectSync(box);
    // The original passed receipt says "rebased"; a reconciled receipt
    // does not. GitHub refuses the former after the real push, not the
    // original attempt or its later read-only settlement.
    box.change((world) => {
      world.failPostsContaining = '"summary":"rebased ';
    });
    const outcome = await box.runBuddy([], SYNC_POLLS, undefined, signal);
    signal.throwIfAborted();
    assert.equal(outcome.status, 0, outcome.stderr);
    const sync = outcome.actions.filter((action) => action.task === "sync");
    assert.equal(sync.length, 2);
    const original = sync.find((action) => action.mode === "act");
    const recovery = sync.find((action) => action.mode === "recover");
    assert.ok(original !== undefined && recovery !== undefined);
    assert.equal(original.verdict, "unknown");
    assert.equal(recovery.verdict, "passed");
    assert.equal(recovery.previous, original.id);
    assert.deepEqual(recovery.binding, original.binding);
    assert.deepEqual(
      recovery.operations.map((op) => [op.op, op.outcome]),
      [["sync-reconcile", "ok"]],
    );
    const code = box.git(["rev-parse", `refs/heads/agent/issue-${ISSUE}`]);
    assert.notEqual(code, from);
    assert.equal(box.git(["merge-base", code, target]), target);
    assert.equal(box.git(["rev-parse", "refs/heads/main"]), target);
    assert.deepEqual(
      box
        .git([
          "reflog",
          "show",
          "--format=%H",
          `refs/heads/agent/issue-${ISSUE}`,
        ])
        .split("\n"),
      [code, from],
    );
    const records = marked(box.world(), "task-result")
      .map((record) => RECORD.parse(record))
      .filter((record) => record.binding.task === "sync");
    assert.equal(
      records.filter((record) => record.kind === "attempt").length,
      1,
    );
    assert.deepEqual(
      records
        .filter((record) => record.kind === "result")
        .map((record) => record.verdict),
      ["unknown", "passed"],
    );
    assert.equal(box.launches().length, 1);
    assert.deepEqual(box.checksRun(), []);
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("a resolver that leaves a real Sync conflict preserves its checkout and starts no retry", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const implemented = await box.runBuddy(
      [IMPLEMENT],
      IMPLEMENT_POLLS,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    assert.equal(implemented.status, 0, implemented.stderr);
    assert.equal(implemented.actions[0]?.verdict, "passed");
    const from = box.git(["rev-parse", `refs/heads/agent/issue-${ISSUE}`]);
    const target = advance(box, "counter.txt");
    selectSync(box);
    const outcome = await box.runBuddy(
      [UNRESOLVED],
      SYNC_POLLS,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    assert.equal(outcome.status, 0, outcome.stderr);
    const sync = outcome.actions.filter((action) => action.task === "sync");
    assert.equal(sync.length, 1);
    const [failed] = sync;
    assert.equal(failed?.verdict, "failed");
    const checkout = failed?.preserved.checkout;
    assert.ok(checkout !== undefined && checkout !== null);
    assert.equal(fs.existsSync(checkout), true);
    const unmerged = git(path.join(checkout, "repo"), [
      "ls-files",
      "--unmerged",
    ]);
    assert.equal(unmerged.includes("counter.txt"), true);
    assert.equal(
      box.git(["rev-parse", `refs/heads/agent/issue-${ISSUE}`]),
      from,
    );
    assert.equal(box.git(["rev-parse", "refs/heads/main"]), target);
    assert.equal(box.launches().length, 2);
    const attempts = marked(box.world(), "task-result")
      .map((record) => RECORD.parse(record))
      .filter(
        (record) => record.kind === "attempt" && record.binding.task === "sync",
      );
    assert.equal(attempts.length, 1);
    assert.deepEqual(box.checksRun(), []);
    passed = true;
  } finally {
    keep(box, passed);
  }
});
