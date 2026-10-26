// Recovery of an uncertain Land through the supported buddy entrypoint, on a
// disposable machine whose trusted repository configuration grants Land.
// The Land's own fast-forward reaches the target but GitHub refuses the
// post of its passed result, so its attempt stays uncertain and keeps the
// target's integration turn. The next poll settles that original attempt
// read-only from the target and gives back its turn. Complete closes the
// issue, loses its own result post and reconciles that original attempt
// without a second close, preserving the original own-Land proof. The
// built buddy.mjs runs the real tasks, ops, ledger, push server and Git;
// only gh (fake-gh.ts) and pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { LANDING, REPO } from "../../support/signals/signal-test-kit.ts";
import type {
  ActionRun,
  BuddyChoice,
  BuddyOutcome,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const IMPLEMENTS: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets\n",
    message: "Count the widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};
const HARDENS: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Checked the count." },
};
const REVIEWS: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { summary: "No security finding.", finding: null },
};
// Implement and Harden each begin on a poll of their own; the third, with
// nothing left to begin, stops the run.
const DEVELOPER_POLLS = 3;
const GATEKEEPER: BuddyChoice = {
  role: "gatekeeper",
  tasks: ["integrate", "review-security", "land", "complete"],
};
// Integrate, Security, uncertain Land and its settlement, then uncertain
// Complete and its settlement each take one poll. The seventh stops.
const GATEKEEPER_POLLS = 7;
// Implement, Harden and Review Security each launch one model session.
const MODEL_SESSIONS = 3;
// Only the Land's own passed result carries its authorization digest.
const OWN_LAND_RESULT = '"authorization":"';
const TURN = `["${REPO}","main","integration"]`;

function begunOf(outcome: BuddyOutcome, task: string): ActionRun[] {
  return outcome.actions.filter(
    (action) =>
      action.task === task &&
      action.buddyRun === outcome.run.id &&
      action.state !== "waiting",
  );
}

function onlyOf(outcome: BuddyOutcome, task: string): ActionRun {
  const [action, ...more] = begunOf(outcome, task);
  if (action === undefined || more.length > 0) {
    throw new Error(`not exactly one ${task} action in the run`);
  }
  return action;
}

test("uncertain own Land and Complete settle their original attempts read-only", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const target = box.git(["rev-parse", "main"]);
    const developer = await box.runBuddy(
      [IMPLEMENTS, HARDENS],
      DEVELOPER_POLLS,
      { role: "developer", tasks: ["implement", "harden"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(developer.status, 0, developer.stderr);
    assert.deepEqual(
      ["implement", "harden"].map((task) => onlyOf(developer, task).verdict),
      ["passed", "passed"],
    );
    const hardened = box.git(["rev-parse", `agent/issue-${ISSUE}`]);
    box.change((reported) => {
      reported.checks = { [hardened]: [{ name: "ci", bucket: "pass" }] };
      reported.failPostsContaining = OWN_LAND_RESULT;
      reported.failPostOnceContaining = '"summary":"completed #';
    });

    const gatekeeper = await box.runBuddy(
      [REVIEWS],
      GATEKEEPER_POLLS,
      GATEKEEPER,
      signal,
    );
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    assert.equal(gatekeeper.ended.kind, "stopped");
    // The Land fast-forwarded the target, then lost its result's post: its
    // own land-task is uncertain and it settled nothing.
    const lands = begunOf(gatekeeper, "land");
    const original = lands.find((action) => action.mode === "act");
    const reconciler = lands.find((action) => action.mode === "recover");
    assert.ok(original !== undefined && reconciler !== undefined);
    assert.equal(lands.length, 2);
    assert.deepEqual(
      [
        original.verdict,
        original.operations.map((item) => [item.op, item.outcome]),
        original.ownership.state,
      ],
      [
        "unknown",
        [
          ["task-attempt", "ok"],
          ["land-task", "failed"],
          ["task-result", "ok"],
        ],
        "released",
      ],
    );
    assert.ok(original.reason?.startsWith("land-task is uncertain: "));
    // Its recovery settled that original attempt from one read of the
    // target, without a new attempt or push.
    assert.deepEqual(
      [
        reconciler.previous,
        reconciler.verdict,
        reconciler.reason,
        reconciler.operations.map((item) => [item.op, item.outcome]),
        reconciler.ownership.state,
      ],
      [
        original.id,
        "passed",
        `landed ${hardened} on main over ${target}`,
        [["land-reconcile", "ok"]],
        "released",
      ],
    );
    assert.deepEqual(reconciler.binding, original.binding);
    const completes = begunOf(gatekeeper, "complete");
    const complete = completes.find((action) => action.mode === "act");
    const completion = completes.find((action) => action.mode === "recover");
    assert.ok(complete !== undefined && completion !== undefined);
    assert.equal(completes.length, 2);
    assert.deepEqual(
      [complete.verdict, complete.binding],
      ["unknown", { ...original.binding, task: "complete" }],
    );
    assert.deepEqual(
      [
        completion.previous,
        completion.verdict,
        completion.binding,
        completion.operations.map((item) => [item.op, item.outcome]),
      ],
      [complete.id, "passed", complete.binding, [["complete-reconcile", "ok"]]],
    );

    // The ledger: the original run's uncertain result, then its passed
    // settlement by the reconciler; the target moved once, by the Land.
    const world = box.world();
    const landResults = marked(world, "task-result").filter(
      (record) =>
        record.kind === "result" &&
        JSON.stringify(record.run) ===
          JSON.stringify({ id: original.id, previous: null }),
    );
    assert.deepEqual(
      landResults.map((record) => record.verdict),
      ["unknown", "passed"],
    );
    assert.deepEqual(landResults.at(-1)?.receipt, {
      summary: `landed ${hardened} on main over ${target}`,
      produced: { code: hardened },
      evidence: {
        reconciledBy: reconciler.id,
        preTarget: { branch: "main", commit: target },
      },
    });
    assert.deepEqual(
      box.git(["reflog", "show", "--format=%H", "refs/heads/main"]).split("\n"),
      [hardened, target],
    );
    // No check or model session ran after the Land.
    assert.equal(box.launches().length, MODEL_SESSIONS);
    assert.deepEqual(box.checksRun(), [hardened]);

    // The reconciler gave back the turn the original Land took, once.
    const turn = marked(world, "coordination").filter(
      (item) => item.scope === TURN,
    );
    assert.deepEqual(
      turn.map((item) => item.kind),
      ["request", "confirm", "release"],
    );
    const released = turn.at(-1);
    assert.ok(released !== undefined);
    const { evidence: retirement } = released;
    assert.deepEqual(retirement, { retiredBy: reconciler.id });
    const issue = world.issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.closed, { by: LANDING, reason: "completed" });
    const ownLand = issue?.comments.find(
      (comment) =>
        comment.body.includes(`"reconciledBy":"${reconciler.id}"`) &&
        comment.body.includes('"kind":"result"'),
    );
    assert.ok(ownLand !== undefined);
    const completionResults = marked(world, "task-result").filter(
      (record) =>
        record.kind === "result" &&
        JSON.stringify(record.run) ===
          JSON.stringify({ id: complete.id, previous: null }),
    );
    assert.deepEqual(
      completionResults.map((record) => record.verdict),
      ["unknown", "passed"],
    );
    assert.deepEqual(completionResults.at(-1)?.receipt, {
      summary: `completed #${ISSUE}: ${hardened} is on main`,
      evidence: {
        land: ownLand.id,
        preTarget: { branch: "main", commit: target },
        reconciledBy: completion.id,
      },
    });
    assert.equal(world.failPostOnceContaining, undefined);
    const closes = fs
      .readFileSync(path.join(box.root, "gh.log"), "utf8")
      .split("\n")
      .filter((line) => line.includes('"args":["issue","close",'));
    assert.equal(closes.length, 1);
    passed = true;
  } finally {
    if (passed) {
      box.cleanup();
    } else {
      process.stderr.write(`Recovery fixture retained: ${box.root}\n`);
    }
  }
});
