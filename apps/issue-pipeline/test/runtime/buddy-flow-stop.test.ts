// The supported buddy entrypoint when a work item's authority changes while
// its Implement session runs: the built buddy.mjs, its real ops,
// pipeline_commit push server, Git and ledger on a disposable machine, with
// only gh (fake-gh.ts) and pi (fake-pi.ts) faked. A stop or authority it
// can't confirm interrupts only this action, the push guard refuses at the
// push and keeps the local commit, evidence still settles, and nothing
// replays the spent start.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { suite, test } from "node:test";
import { z } from "zod";
import type {
  ActionRun,
  Machine,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const COMMIT = {
  file: "counter.txt",
  content: "3 widgets\n",
  message: "Count the widgets",
};
const PUSH_REPLY = z.looseObject({
  pushed: z.string(),
  pushError: z.string().nullable(),
  isError: z.boolean().optional(),
});
const DONE = { outcome: "done", summary: "Counted the widgets." };
const BRANCH = `agent/issue-${ISSUE}`;
const ISSUE_SCOPE = `["acme/widgets","main","issue",${ISSUE},"${BRANCH}"]`;
const POOL_SCOPE = '["acme/widgets","main","resource","model-session",1]';
const SIGTERM = { scope: "buddy", reason: "SIGTERM received" };
// The poll at whose first listing the fake gh stops the buddy: after the
// action and one more cycle.
const STOP_AT_POLL = 3;
const UNACCEPTED_STOP =
  /^interrupted: stop latch unknown: agents:stop event \d+ by @autumn is not accepted yet$/u;
const STOP_ACCEPTED = /^stop .* was accepted$/u;
const STOP_UNKNOWN_PUSH = /^#7's stop is unknown: /u;
const LABELS_UNREADABLE =
  /^interrupted: stop latch unknown: control labels unreadable: /u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const EVENTS = /events/u;
const EXECUTION_HOLD = /issue execution/u;
const START_REVOKED_PUSH =
  /^signal github-label:acme\/widgets#7:300 is revoked: @autumn is not a member of acme/u;
const PUSH_BOUNDARY_REVOKED = /^push: signal .* revoked: /u;

function planned(change: Partial<PlannedSession>): PlannedSession {
  return {
    commit: null,
    change: null,
    changeFirst: false,
    awaitAbort: false,
    reply: DONE,
    ...change,
  };
}

// The settled state of `action` the tests compare.
interface Settled {
  state: ActionRun["state"];
  outcome: ActionRun["outcome"];
  verdict: ActionRun["verdict"];
  stop: ActionRun["stop"];
  checkpoint: ActionRun["checkpoint"]["state"];
  ownership: ActionRun["ownership"]["state"];
  reservations: string[];
  sessions: unknown[];
  operations: unknown[][];
}

function settled(action: ActionRun): Settled {
  return {
    state: action.state,
    outcome: action.outcome,
    verdict: action.verdict,
    stop: action.stop,
    checkpoint: action.checkpoint.state,
    ownership: action.ownership.state,
    reservations: action.reservations.map((item) => item.state),
    sessions: action.sessions.map((item) => item.outcome),
    operations: action.operations.map((item) => [item.op, item.outcome]),
  };
}

// The task-result ledger of the issue: kinds and verdicts, oldest first.
function ledger(box: Machine): unknown[] {
  return marked(box.world(), "task-result").map((item) => [
    item.kind,
    item.verdict ?? null,
  ]);
}

// What each of the session's pipeline_commit calls answered: whether the
// tool failed, what it pushed and why the push was refused.
function sessionPushes(box: Machine): z.infer<typeof PUSH_REPLY>[] {
  return box.commits().map((result) => ({
    ...PUSH_REPLY.parse(JSON.parse(result.content[0]?.text ?? "null")),
    isError: result.isError,
  }));
}

// The commit `action`'s recovery bundle saved for the operator, or why it
// can't be listed.
function bundledHead(box: Machine, action: ActionRun): string {
  const bundle = path.join(
    box.pipeline,
    "runs",
    "acme__widgets",
    `issue-${ISSUE}`,
    "recovery",
    `${action.id}-code.bundle`,
  );
  const heads = spawnSync("git", ["bundle", "list-heads", bundle], {
    encoding: "utf8",
  });
  if (heads.status !== 0) {
    return `unlisted: ${heads.stderr}`;
  }
  const [sha = ""] = heads.stdout.trim().split(" ");
  return sha;
}

function originBranch(box: Machine): string {
  return box.git(["branch", "--list", BRANCH]);
}

// The world's accepted agents:stop signal records.
function acceptedStops(box: Machine): unknown[] {
  return marked(box.world(), "signal").filter((item) =>
    JSON.stringify(item).includes('"label":"agents:stop"'),
  );
}

suite("buddy authority changes during an Implement session", {
  concurrency: true,
}, () => {
  test("a person's new agents:stop interrupts only that work item's waiting session", async () => {
    const box = machine();
    try {
      const { status, ended, run, actions } = await box.runBuddy(
        [
          planned({
            change: "stop-issue",
            awaitAbort: true,
            reply: null,
          }),
        ],
        STOP_AT_POLL,
      );
      assert.equal(status, 0);
      // The buddy run went on polling until its own SIGTERM; the stop
      // was the work item's alone.
      assert.equal(ended.kind, "stopped");
      assert.deepEqual(
        { scope: run.stop?.scope, reason: run.stop?.reason },
        SIGTERM,
      );
      assert.equal(actions.length, 1);
      const [action] = actions;
      assert.ok(action !== undefined);
      // The stop was not accepted yet when the session waited: a local
      // interruption, its result recorded unknown, nothing pushed.
      assert.deepEqual(settled(action), {
        state: "ended",
        outcome: "unknown",
        verdict: "unknown",
        stop: null,
        checkpoint: "none",
        ownership: "released",
        reservations: ["released"],
        sessions: ["failed"],
        operations: [
          ["task-attempt", "ok"],
          ["task-result", "ok"],
        ],
      });
      assert.match(action.reason ?? "", UNACCEPTED_STOP);
      assert.deepEqual(ledger(box), [
        ["attempt", null],
        ["result", "unknown"],
      ]);
      // The next poll accepted the person's stop, and the loop reports it.
      assert.equal(acceptedStops(box).length, 1);
      assert.match(run.loops[0]?.reason ?? "", STOP_ACCEPTED);
      assert.equal(box.launches().length, 1);
      assert.equal(originBranch(box), "");
    } finally {
      box.cleanup();
    }
  });

  test("unreadable stop evidence interrupts locally, and restored evidence replays no start", async () => {
    const box = machine();
    try {
      const first = await box.runBuddy(
        [
          planned({
            commit: COMMIT,
            change: "events-unreadable",
            changeFirst: true,
            awaitAbort: true,
            reply: null,
          }),
        ],
        STOP_AT_POLL,
      );
      assert.equal(first.status, 0);
      assert.deepEqual(
        { scope: first.run.stop?.scope, reason: first.run.stop?.reason },
        SIGTERM,
      );
      const [action] = first.actions;
      assert.ok(action !== undefined);
      assert.equal(first.actions.length, 1);
      // The push guard refused at the push; the commit is kept locally.
      const [push, ...more] = sessionPushes(box);
      assert.deepEqual(more, []);
      assert.equal(push?.isError, false);
      assert.equal(push.pushed, "none");
      assert.match(push.pushError ?? "", STOP_UNKNOWN_PUSH);
      assert.equal(originBranch(box), "");
      // Unknown is no stop: an interruption of this action alone, no stop
      // recorded or fabricated, and its evidence still settled.
      assert.deepEqual(settled(action), {
        state: "ended",
        outcome: "unknown",
        verdict: "unknown",
        stop: null,
        checkpoint: "none",
        ownership: "released",
        reservations: ["released"],
        sessions: ["failed"],
        operations: [
          ["task-attempt", "ok"],
          ["task-result", "ok"],
        ],
      });
      assert.match(action.reason ?? "", LABELS_UNREADABLE);
      assert.match(bundledHead(box, action), FULL_SHA);
      assert.deepEqual(acceptedStops(box), []);
      assert.equal(
        box
          .world()
          .issues.find((item) => item.number === ISSUE)
          ?.labels.includes("agents:stop"),
        false,
      );
      assert.deepEqual(ledger(box), [
        ["attempt", null],
        ["result", "unknown"],
      ]);
      // The loop shows the unreadable item held, not idle or waiting.
      assert.equal(first.run.loops[0]?.state, "held");
      assert.match(first.run.loops[0]?.reason ?? "", EVENTS);
      // Readable again, a new activation sees the start spent by the
      // unknown attempt: no new action, attempt or session.
      box.change((world) => {
        world.faults = [];
      });
      const second = await box.runBuddy([], STOP_AT_POLL);
      assert.equal(second.status, 0);
      assert.deepEqual(
        { scope: second.run.stop?.scope, reason: second.run.stop?.reason },
        SIGTERM,
      );
      assert.deepEqual(
        second.actions.map((item) => item.id),
        [action.id],
      );
      assert.equal(second.run.loops[0]?.action, null);
      assert.equal(box.launches().length, 1);
      assert.deepEqual(ledger(box), [
        ["attempt", null],
        ["result", "unknown"],
      ]);
      assert.equal(originBranch(box), "");
    } finally {
      box.cleanup();
    }
  });

  test("a starter who leaves before the push refuses it and keeps the local commit", async () => {
    const box = machine();
    try {
      const { status, actions } = await box.runBuddy(
        [
          planned({
            commit: COMMIT,
            change: "human-leaves",
            changeFirst: true,
          }),
        ],
        STOP_AT_POLL,
      );
      assert.equal(status, 0);
      const [action] = actions;
      assert.ok(action !== undefined);
      assert.equal(actions.length, 1);
      const [push, ...more] = sessionPushes(box);
      assert.deepEqual(more, []);
      assert.equal(push?.isError, false);
      assert.equal(push.pushed, "none");
      assert.match(push.pushError ?? "", START_REVOKED_PUSH);
      assert.equal(originBranch(box), "");
      // The checkpoint still settled; the push and PR ops never ran.
      assert.deepEqual(settled(action), {
        state: "ended",
        outcome: "unknown",
        verdict: "unknown",
        stop: null,
        checkpoint: "saved",
        ownership: "released",
        reservations: ["released"],
        sessions: ["ok"],
        operations: [
          ["task-attempt", "ok"],
          ["checkpoint-action", "ok"],
          ["task-result", "ok"],
        ],
      });
      assert.match(action.reason ?? "", PUSH_BOUNDARY_REVOKED);
      assert.deepEqual(ledger(box), [
        ["attempt", null],
        ["result", "unknown"],
      ]);
      // The local commit is preserved for the operator, not pushed.
      assert.match(bundledHead(box, action), FULL_SHA);
      assert.equal(box.world().pulls?.length, 0);
    } finally {
      box.cleanup();
    }
  });

  test("an uncertain checkpoint retains the checkout, the issue and the session slot", async () => {
    const box = machine();
    try {
      const { status, run, actions } = await box.runBuddy(
        [planned({ commit: COMMIT, change: "checkpoint-posts-fail" })],
        STOP_AT_POLL,
      );
      assert.equal(status, 0);
      const [action] = actions;
      assert.ok(action !== undefined);
      assert.equal(actions.length, 1);
      assert.deepEqual(
        sessionPushes(box).map((item) => [item.isError, item.pushed]),
        [[false, "code"]],
      );
      assert.equal(action.checkpoint.state, "uncertain");
      assert.equal(action.ownership.state, "retained");
      assert.deepEqual(
        action.reservations.map((item) => item.state),
        ["held"],
      );
      // No substantive op after the uncertain checkpoint.
      const ops = action.operations.map((item) => item.op);
      assert.equal(ops.includes("push"), false);
      assert.equal(ops.includes("open-task-pr"), false);
      // The checkout stays whole, with the session's commit in it.
      const { checkout } = action.preserved;
      assert.ok(checkout !== null);
      assert.ok(fs.existsSync(checkout));
      const local = spawnSync(
        "git",
        ["-C", path.join(checkout, "repo"), "log", "-1", "--format=%s"],
        { encoding: "utf8" },
      );
      assert.equal(local.status, 0, local.stderr);
      assert.equal(local.stdout.trim(), COMMIT.message);
      // Neither the issue's execution nor the pool's slot was released.
      const releases = marked(box.world(), "coordination")
        .filter((item) => item.kind === "release")
        .map((item) => item.scope);
      assert.equal(releases.includes(ISSUE_SCOPE), false);
      assert.equal(releases.includes(POOL_SCOPE), false);
      assert.equal(run.loops[0]?.action, action.id);
      assert.equal(run.loops[0]?.state, "held");
      assert.match(run.loops[0]?.reason ?? "", EXECUTION_HOLD);
      // Fresh activation sees authenticated ownership, not just a local
      // action file. A spent start cannot hide retained work as idle.
      const next = await box.runBuddy([], STOP_AT_POLL);
      assert.equal(next.status, 0, next.stderr);
      assert.equal(next.run.loops[0]?.state, "held");
      assert.match(next.run.loops[0]?.reason ?? "", EXECUTION_HOLD);
      assert.equal(box.launches().length, 1);
      assert.ok(fs.existsSync(checkout));
      assert.deepEqual(
        next.actions.map((item) => item.id),
        [action.id],
      );
    } finally {
      box.cleanup();
    }
  });
});
