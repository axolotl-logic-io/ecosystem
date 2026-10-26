// Fix's uncertain and unresolved ends through the built buddy: a run whose
// result record was lost is settled read-only from the branch and its
// thread replies, with no second attempt, session, push or reply; and a
// session that leaves a real merge conflict keeps its evidence, pushes
// nothing and is never retried. Only the GitHub and model transports fake;
// recovery reads the effects the Fix that actually ran here made.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  advanceTarget,
  BRANCH,
  implemented,
  landFindsConflict,
  records,
  verifyRequestsChanges,
} from "./buddy-flow-review-test-kit.ts";
import type {
  BuddyChoice,
  Machine,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { ISSUE, machine } from "./buddy-flow-test-kit.ts";

const FIXER: BuddyChoice = { role: "developer", tasks: ["fix"] };
// The Fix acts on one poll and its recovery on the next.
const RECOVERY_POLLS = 3;
const FIX_POLLS = 2;
const SLUG = "acme__widgets";
// Implement's writing and hardening sessions, and the one Fix session.
const SESSIONS = 3;
const BLOCKING = "Count with a number, not words.";
// Only the passed result's receipt evidence lists the replies: GitHub
// refuses that post after the real push and replies, and nothing else.
const PASSED_EVIDENCE = '"replies":[';
const UNRESOLVED_REASON = /was left unresolved: counter\.txt/u;
const NEVER_RETRIED = /never retried automatically/u;
const UNRESOLVED: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Left the merge as it was.", replies: [] },
};

function fixRecords(box: Machine): ReturnType<typeof records> {
  return records(box).filter((record) => record.binding.task === "fix");
}

function keep(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`Fix recovery evidence retained at ${box.root}\n`);
}

// The issue's recovery folders' files, by folder.
function recovered(box: Machine): string[][] {
  const dir = path.join(
    box.pipeline,
    "runs",
    SLUG,
    `issue-${ISSUE}`,
    "recovery",
  );
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("merge-"))
    .map((name) => fs.readdirSync(path.join(dir, name)).sort());
}

test("Fix reconciles its own pushed head and replies without another attempt, session, push or reply", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    const target = box.git(["rev-parse", "main"]);
    const verify = verifyRequestsChanges(box, item, {
      target,
      body: "The count must be a number.",
      comments: [{ path: "counter.txt", line: 1, body: BLOCKING }],
    });
    const [thread] = verify.threads;
    assert.ok(thread !== undefined);
    box.change((world) => {
      world.failPostsContaining = PASSED_EVIDENCE;
    });
    const fixes: PlannedSession = {
      commit: {
        file: "counter.txt",
        content: "3 widgets\n",
        message: "Count with a number",
      },
      change: null,
      changeFirst: false,
      awaitAbort: false,
      reply: {
        outcome: "done",
        summary: "Counted with a number.",
        replies: [{ comment: thread, reply: "The count is a number now." }],
      },
    };
    const run = await box.runBuddy([fixes], RECOVERY_POLLS, FIXER, signal);
    assert.equal(run.status, 0, run.stderr);
    const fix = run.actions.filter((action) => action.task === "fix");
    assert.equal(fix.length, 2);
    const original = fix.find((action) => action.mode === "act");
    const recovery = fix.find((action) => action.mode === "recover");
    assert.ok(original !== undefined && recovery !== undefined);
    assert.equal(original.verdict, "unknown");
    assert.equal(recovery.verdict, "passed", recovery.reason ?? "");
    assert.equal(recovery.previous, original.id);
    assert.deepEqual(recovery.binding, original.binding);
    assert.deepEqual(
      recovery.operations.map((op) => [op.op, op.outcome]),
      [["fix-reconcile", "ok"]],
    );
    assert.deepEqual(recovery.sessions, []);
    // The branch moved once, from the reviewed head to the Fix.
    const head = box.git(["rev-parse", BRANCH]);
    assert.deepEqual(
      box
        .git(["reflog", "show", "--format=%H", `refs/heads/${BRANCH}`])
        .split("\n")
        .slice(0, 2),
      [head, item.head],
    );
    // One reply in the thread, from the original run.
    const replies = (box.world().pulls?.[0]?.reviewComments ?? []).filter(
      (comment) => comment.inReplyTo === thread,
    );
    assert.equal(replies.length, 1);
    // One attempt, settled first unknown and then passed by reading.
    const ledger = fixRecords(box);
    assert.equal(
      ledger.filter((record) => record.kind === "attempt").length,
      1,
    );
    assert.deepEqual(
      ledger.flatMap((record) => {
        if (record.kind !== "result") {
          return [];
        }
        return [[record.verdict, record.receipt.produced?.code ?? null]];
      }),
      [
        ["unknown", null],
        ["passed", head],
      ],
    );
    // Implement's two sessions and the Fix's one: recovery started none.
    assert.equal(box.launches().length, SESSIONS);
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("a Fix session that leaves a real merge conflict keeps its evidence, pushes nothing and starts no retry", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    const target = advanceTarget(box, "counter.txt", "four widgets\n");
    landFindsConflict(box, item, { target, cause: item.result });
    const run = await box.runBuddy([UNRESOLVED], FIX_POLLS, FIXER, signal);
    assert.equal(run.status, 0, run.stderr);
    const fix = run.actions.filter((action) => action.task === "fix");
    assert.equal(fix.length, 1);
    const [failed] = fix;
    assert.equal(failed?.verdict, "failed");
    assert.match(failed?.reason ?? "", UNRESOLVED_REASON);
    // Nothing reached the branch or the PR; the base is untouched.
    assert.equal(box.git(["rev-parse", BRANCH]), item.head);
    assert.equal(box.git(["rev-parse", "main"]), target);
    assert.equal(box.world().pulls?.[0]?.isDraft, true);
    // The conflict's numbered stages and the checkout's commits are kept.
    assert.deepEqual(recovered(box), [
      ["commits.bundle", "conflict-stages.json"],
    ]);
    // The failed binding is never retried: a new activation holds it.
    const again = await box.runBuddy([], FIX_POLLS, FIXER, signal);
    assert.equal(again.status, 0);
    assert.equal(
      again.actions.filter((action) => action.task === "fix").length,
      1,
    );
    const loop = again.run.loops.find((entry) => entry.task === "fix");
    assert.equal(loop?.state, "held");
    assert.match(loop?.reason ?? "", NEVER_RETRIED);
    assert.equal(
      fixRecords(box).filter((record) => record.kind === "attempt").length,
      1,
    );
    // Implement's two sessions and the one Fix session.
    assert.equal(box.launches().length, SESSIONS);
    passed = true;
  } finally {
    keep(box, passed);
  }
});
