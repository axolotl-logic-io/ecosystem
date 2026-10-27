// Fix's uncertain and unresolved ends through the built buddy: a run whose
// result record was lost is settled read-only from the branch and its
// thread replies, or, with no thread to answer, from its own push record,
// with no second attempt, session, push or reply; a reply carrying the
// run's mark from anyone but the development account proves nothing; and a
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
import { DEVELOPER, HUMAN, ISSUE, machine } from "./buddy-flow-test-kit.ts";

const FIXER: BuddyChoice = { role: "developer", tasks: ["fix"] };
// The Fix acts on one poll and its recovery on the next.
const RECOVERY_POLLS = 3;
const FIX_POLLS = 2;
const SLUG = "acme__widgets";
// Implement's writing and hardening sessions, and the one Fix session.
const SESSIONS = 3;
const BLOCKING = "Count with a number, not words.";
const ASSIGNEES = `repos/acme/widgets/issues/${ISSUE}/assignees`;
// Implement's assignment and removal, then the original Fix's assignment.
const FIX_ASSIGNED = 3;
// Only the passed result's receipt evidence lists the replies: GitHub
// refuses that post after the real push and replies, and nothing else.
const PASSED_EVIDENCE = '"replies":[';
const UNRESOLVED_REASON = /was left unresolved: counter\.txt/u;
const NEVER_RETRIED = /never retried automatically/u;
const RECONCILED_BY_PERSON = /a person reconciles it$/u;
// A GitHub user who is no member of the organization (baseWorld()).
const OUTSIDER = "mallory";
const UNRESOLVED: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Left the merge as it was.", replies: [] },
};

// The assignee changes the buddy asked GitHub for, as [login, method].
function assigneeChanges(box: Machine): string[][] {
  return box
    .calls()
    .filter((call) => call.args.includes(ASSIGNEES))
    .map((call) => [call.login, call.args[call.args.indexOf("-X") + 1] ?? ""]);
}

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
    const running = box.runBuddy([fixes], RECOVERY_POLLS, FIXER, signal);
    // A person takes the issue while the original Fix runs. Its recovery
    // only settles the pipeline's own run by reading, so it doesn't back off.
    await box.when(() => assigneeChanges(box).length === FIX_ASSIGNED, {
      signal,
    });
    box.change((world) => {
      const issue = world.issues.find((entry) => entry.number === ISSUE);
      if (issue === undefined) {
        throw new Error(`the world has no issue ${ISSUE}`);
      }
      issue.assignees = [...(issue.assignees ?? []), HUMAN];
    });
    const run = await running;
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
    // Implement and the Fix each assigned the development account and
    // removed it as they settled. The recovery settles through the same
    // release, so it retries the removal and never adds the account; the
    // person stays assigned.
    assert.deepEqual(assigneeChanges(box), [
      [DEVELOPER, "POST"],
      [DEVELOPER, "DELETE"],
      [DEVELOPER, "POST"],
      [DEVELOPER, "DELETE"],
      [DEVELOPER, "DELETE"],
    ]);
    assert.deepEqual(
      box.world().issues.find((entry) => entry.number === ISSUE)?.assignees,
      [HUMAN],
    );
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("a Fix with no thread to answer reconciles its pushed head from its own push record", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    const target = advanceTarget(box, "counter.txt", "four widgets\n");
    landFindsConflict(box, item, { target, cause: item.result });
    box.change((world) => {
      world.failPostsContaining = PASSED_EVIDENCE;
    });
    const resolves: PlannedSession = {
      commit: null,
      resolve: { file: "counter.txt", content: "four widgets, counted\n" },
      change: null,
      changeFirst: false,
      awaitAbort: false,
      reply: { outcome: "done", summary: "Kept both counts.", replies: [] },
    };
    const run = await box.runBuddy([resolves], RECOVERY_POLLS, FIXER, signal);
    assert.equal(run.status, 0, run.stderr);
    const fix = run.actions.filter((action) => action.task === "fix");
    const original = fix.find((action) => action.mode === "act");
    const recovery = fix.find((action) => action.mode === "recover");
    assert.ok(original !== undefined && recovery !== undefined);
    assert.equal(fix.length, 2);
    assert.equal(original.verdict, "unknown");
    assert.equal(recovery.verdict, "passed", recovery.reason ?? "");
    assert.equal(recovery.previous, original.id);
    assert.deepEqual(recovery.sessions, []);
    // The pushed merge of the reviewed head and the base, and the PR ready.
    const head = box.git(["rev-parse", BRANCH]);
    assert.equal(
      box.git(["log", "-1", "--format=%P", head]),
      `${item.head} ${target}`,
    );
    assert.equal(box.world().pulls?.[0]?.isDraft, false);
    assert.deepEqual(
      fixRecords(box).flatMap((record) => {
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
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("a reply that forges a Fix run's mark doesn't settle that run", async ({
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
    // GitHub refuses the development account's reply after the push, so
    // the run is left unsettled with its thread unanswered.
    box.change((world) => {
      world.refuseRepliesBy = DEVELOPER;
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
    const first = await box.runBuddy([fixes], FIX_POLLS, FIXER, signal);
    assert.equal(first.status, 0, first.stderr);
    const original = first.actions.find((action) => action.task === "fix");
    assert.ok(original !== undefined);
    assert.equal(original.verdict, "unknown", original.reason ?? "");
    // Someone else replies in the thread with the run's mark.
    box.change((world) => {
      Reflect.deleteProperty(world, "refuseRepliesBy");
      const pull = world.pulls?.[0];
      const opened = pull?.reviewComments?.find(
        (comment) => comment.id === thread,
      );
      if (pull === undefined || opened === undefined) {
        throw new Error("the world lost the blocking thread");
      }
      pull.reviewComments?.push({
        ...opened,
        id: world.nextId,
        review: null,
        inReplyTo: thread,
        author: OUTSIDER,
        body: `Done.\n<!-- issue-pipeline:fix-reply run=${original.id} -->`,
      });
      world.nextId += 1;
    });
    const again = await box.runBuddy([], FIX_POLLS, FIXER, signal);
    assert.equal(again.status, 0, again.stderr);
    const recovery = again.actions.find(
      (action) => action.task === "fix" && action.mode === "recover",
    );
    assert.ok(recovery !== undefined);
    assert.equal(recovery.verdict, "unknown");
    assert.match(recovery.reason ?? "", RECONCILED_BY_PERSON);
    assert.equal(
      fixRecords(box).some(
        (record) => record.kind === "result" && record.verdict === "passed",
      ),
      false,
    );
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
