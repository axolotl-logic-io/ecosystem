import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { RECORD } from "../../../src/tasks/records.ts";
import type { PlannedSession } from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const INTERRUPTED: PlannedSession = {
  commit: null,
  strayWrite: {
    file: "unfinished.txt",
    content: "Keep this unfinished work.\n",
  },
  change: "comments-unreadable",
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "The session ended before settlement." },
};
const PREVIEW = z.looseObject({ state: z.literal("ready") });
const RELEASED = z.strictObject({
  action: z.uuid(),
  state: z.literal("released"),
  resumed: z.literal(false),
});
const POLLS = 2;
const SETTLEMENT_TRANSITIONS = 3;

// A real model process exits, then the GitHub read before reporting that
// exit fails. Neither the done record nor the result was ever sent. This
// is not a test that frees a reservation merely because its PID vanished.
test("an operator settles the original interrupted Implement and drains its consumers without retrying it", async ({
  signal,
}) => {
  const box = machine();
  try {
    const run = await box.runBuddy([INTERRUPTED], POLLS, undefined, signal);
    assert.equal(run.status, 0, run.stderr);
    const [action] = run.actions;
    assert.ok(action !== undefined);
    assert.equal(action.ownership.state, "retained");
    assert.equal(action.sessions[0]?.outcome, null);
    assert.ok(action.sessions[0]?.endedAt !== null);
    assert.ok(action.preserved.patches.length > 0);
    const [patch] = action.preserved.patches;
    assert.ok(patch !== undefined);
    const patchFile = path.join(
      box.pipeline,
      "runs",
      "acme__widgets",
      `issue-${ISSUE}`,
      patch,
    );
    const before = fs.readFileSync(patchFile);
    box.change((world) => {
      world.faults = [];
    });
    const count = box.calls().length;
    const preview = box.recoverImplement(action.id, false);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(PREVIEW.parse(JSON.parse(preview.stdout)).state, "ready");
    assert.ok(
      box
        .calls()
        .slice(count)
        .every((call) => !call.args.includes("POST")),
    );
    // A published work branch makes this narrow operator path ineligible.
    const branch = `refs/heads/agent/issue-${ISSUE}`;
    box.git(["update-ref", branch, "refs/heads/main"]);
    const published = box.recoverImplement(action.id, true);
    assert.equal(published.status, 1);
    assert.ok(published.stderr.includes("the work branch exists"));
    box.git(["update-ref", "-d", branch]);
    const applied = box.recoverImplement(action.id, true);
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(RELEASED.parse(JSON.parse(applied.stdout)), {
      action: action.id,
      state: "released",
      resumed: false,
    });
    const records = marked(box.world(), "task-result").map((row) =>
      RECORD.parse(row),
    );
    assert.equal(records.length, 2);
    assert.equal(records[0]?.kind, "attempt");
    const [, result] = records;
    assert.ok(result?.kind === "result");
    assert.equal(result.verdict, "failed");
    assert.deepEqual(records[1]?.run, records[0]?.run);
    assert.deepEqual(records[1]?.cause, records[0]?.cause);
    assert.deepEqual(fs.readFileSync(patchFile), before);
    assert.deepEqual(
      marked(box.world(), "coordination")
        .map((row) => row.kind)
        .slice(-SETTLEMENT_TRANSITIONS),
      ["done", "release", "release"],
    );
    const next = await box.runBuddy([], POLLS, undefined, signal);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(box.launches().length, 1);
    assert.deepEqual(box.world().pulls ?? [], []);
  } finally {
    box.cleanup();
  }
});

test("a missing preservation artifact prevents operator settlement", async ({
  signal,
}) => {
  const box = machine();
  try {
    const run = await box.runBuddy([INTERRUPTED], POLLS, undefined, signal);
    const [action] = run.actions;
    assert.ok(action !== undefined);
    box.change((world) => {
      world.faults = [];
    });
    const [patch] = action.preserved.patches;
    assert.ok(patch !== undefined);
    fs.unlinkSync(
      path.join(box.pipeline, "runs", "acme__widgets", `issue-${ISSUE}`, patch),
    );
    const before = box.world();
    const result = box.recoverImplement(action.id, true);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(patch));
    assert.deepEqual(box.world(), before);
  } finally {
    box.cleanup();
  }
});
