// Operator-visible holds through the built buddy, with real polling and
// observation records. Only GitHub and model sessions are faked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import { ISSUE, machine } from "./buddy-flow-test-kit.ts";

const POLLS = 4;
const COMMENT = 600;
const UNTRUSTED_PROVENANCE = /untrusted author\/editor provenance/u;
const CREATED = "2026-10-25T00:00:00Z";
const HELD = z.object({
  at: z.iso.datetime(),
  buddyRun: z.uuid(),
  repo: z.string(),
  task: z.string(),
  state: z.literal("held"),
  reason: z.string(),
});

test("an unchanged hold reaches stderr once across repeated polls", async ({
  signal,
}) => {
  const box = machine((world) => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    assert.ok(issue !== undefined);
    issue.comments.push({
      id: COMMENT,
      author: LANDING,
      body: "<!-- agent-pipeline:task-result\n{}\n-->",
      editor: "autumn",
      createdAt: CREATED,
    });
  });
  try {
    const run = await box.runBuddy([], POLLS, undefined, signal);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions.length, 0);
    const logs = run.stderr
      .trim()
      .split("\n")
      .map((line) => HELD.parse(JSON.parse(line)));
    assert.equal(logs.length, 1, run.stderr);
    assert.equal(logs[0]?.buddyRun, run.run.id);
    assert.equal(logs[0]?.repo, "acme/widgets");
    assert.equal(logs[0]?.task, "implement");
    assert.match(logs[0]?.reason ?? "", UNTRUSTED_PROVENANCE);
    assert.equal(logs[0]?.reason, run.run.loops[0]?.reason);
    assert.equal(box.world().stopBuddy?.polls, POLLS);
  } finally {
    box.cleanup();
  }
});
