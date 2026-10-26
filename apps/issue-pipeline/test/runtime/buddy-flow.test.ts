// The supported buddy entrypoint, end to end on a disposable machine: the
// built buddy.mjs admits a human-started Implement, its writer session
// commits through the real pipeline_commit extension and push server, a
// fresh hardening session follows it, and the task settles through the real
// ops, ledger and origin. Only gh
// (fake-gh.ts) and pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { PlannedSession } from "./buddy-flow-test-kit.ts";
import {
  DEVELOPER,
  HARDENING,
  ISSUE,
  machine,
  marked,
} from "./buddy-flow-test-kit.ts";

const COMMIT = {
  file: "counter.txt",
  content: "3 widgets\n",
  message: "Count the widgets",
};
const COUNTS: PlannedSession = {
  commit: COMMIT,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};
const ISSUE_SCOPE = `["acme/widgets","main","issue",${ISSUE},"agent/issue-${ISSUE}"]`;
const POOL_SCOPE = '["acme/widgets","main","resource","model-session",1]';

test("a buddy implements a started issue through its real ops and releases it", async () => {
  const box = machine();
  try {
    const { status, ended, run, actions } = await box.runBuddy(
      [COUNTS, HARDENING],
      2,
    );
    assert.equal(status, 0);
    assert.equal(ended.kind, "stopped");
    assert.equal(actions.length, 1);
    const [action] = actions;
    assert.ok(action !== undefined);
    assert.equal(run.loops[0]?.action, action.id);
    // Ownership, the reservation and its two consumers, the checkout, the
    // bound ops, a checkpoint after each session and the settlement, in the
    // observation.
    assert.deepEqual(
      {
        state: action.state,
        outcome: action.outcome,
        verdict: action.verdict,
        checkpoint: action.checkpoint.state,
        ownership: action.ownership,
        reservations: action.reservations.map((item) => item.state),
        sessions: action.sessions.map((item) => [item.outcome, item.commits]),
        operations: action.operations.map((item) => [item.op, item.outcome]),
        preserved: action.preserved,
      },
      {
        state: "ended",
        outcome: "succeeded",
        verdict: "passed",
        checkpoint: "saved",
        ownership: { state: "released", reason: null },
        reservations: ["released"],
        sessions: [
          ["ok", true],
          ["ok", true],
        ],
        operations: [
          ["task-attempt", "ok"],
          ["checkpoint-action", "ok"],
          ["checkpoint-action", "ok"],
          ["push", "ok"],
          ["open-task-pr", "ok"],
          ["task-result", "ok"],
        ],
        preserved: { checkout: null, patches: [] },
      },
    );
    // The sessions ran in the action's own checkout, and safe release
    // removed it.
    const [launch] = box.launches();
    assert.ok(launch !== undefined);
    assert.equal(box.launches().length, 2);
    assert.ok(launch.cwd.endsWith(`issue-${ISSUE}-action-${action.id}`));
    assert.ok(
      launch.args.includes(path.join(box.pipeline, "pipeline-commit.mjs")),
    );
    assert.equal(fs.existsSync(launch.cwd), false);
    // The commit reached the origin's work branch on top of the target.
    const head = box.git(["rev-parse", `agent/issue-${ISSUE}`]);
    assert.equal(box.git(["log", "-1", "--format=%s", head]), COMMIT.message);
    assert.equal(box.git(["show", `${head}:${COMMIT.file}`]), "3 widgets");
    assert.equal(
      box.git(["rev-parse", `${head}^`]),
      box.git(["rev-parse", "main"]),
    );
    const world = box.world();
    assert.deepEqual(
      world.pulls?.map((pull) => [
        pull.head,
        pull.base,
        pull.author,
        pull.body,
      ]),
      [[`agent/issue-${ISSUE}`, "main", DEVELOPER, `Closes #${ISSUE}`]],
    );
    // The ledger: one attempt and its passed result for this action,
    // producing that commit.
    const results = marked(world, "task-result");
    assert.deepEqual(
      results.map((item) => [item.kind, item.run, item.verdict]),
      [
        ["attempt", { id: action.id, previous: null }, undefined],
        ["result", { id: action.id, previous: null }, "passed"],
      ],
    );
    assert.deepEqual(results[1]?.receipt, {
      summary: "Counted the widgets.",
      produced: { code: head },
    });
    // Coordination: the issue's execution and the pool's slot each
    // requested, confirmed and released; each session registered as the
    // slot's consumer and done before release.
    const coordination = marked(world, "coordination").map((item) => [
      item.scope,
      item.kind,
    ]);
    assert.deepEqual(coordination, [
      [ISSUE_SCOPE, "request"],
      [ISSUE_SCOPE, "confirm"],
      [POOL_SCOPE, "request"],
      [POOL_SCOPE, "confirm"],
      [POOL_SCOPE, "register"],
      [POOL_SCOPE, "done"],
      [POOL_SCOPE, "register"],
      [POOL_SCOPE, "done"],
      [POOL_SCOPE, "release"],
      [ISSUE_SCOPE, "release"],
    ]);
    const consumers = marked(world, "coordination")
      .filter((item) => item.kind === "register")
      .map((item) => item.consumer);
    assert.deepEqual(
      consumers,
      action.sessions.map((session) => ({
        kind: "model-session",
        id: session.id,
      })),
    );
  } finally {
    box.cleanup();
  }
});
