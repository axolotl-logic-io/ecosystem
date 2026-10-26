// The supported buddy entrypoint with a lane slot pool and a configured
// setup command: the built buddy.mjs registers Implement's own checkout as
// its issue's lane-slot consumer, runs the pinned setup there through the
// guarded prepare-checkout op with the leased ISSUE_PIPELINE_LANE_SLOT, and
// the writing session and its fresh hardening session inherit that slot,
// never the operator's own, with setup run once for both. A failed
// setup starts no session, retains the checkout, its untracked work, its
// slot and its readiness barrier, and holds the issue so nothing replays.
// Verify's own checkout, its detached checks checkout and its review
// session use the same leased slot.
// Only gh (fake-gh.ts) and pi (fake-pi.ts) are fakes; setup is the
// project's own shell command.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { ISSUE, machine } from "./buddy-flow-test-kit.ts";

const SLUG = "acme__widgets";
const COUNTS: PlannedSession = {
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
  ...COUNTS,
  commit: {
    file: "counter.txt",
    content: "3 widgets, checked\n",
    message: "Check the widget count",
  },
  reply: { outcome: "done", summary: "Checked the count." },
};
const REVIEWS: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { summary: "Read the whole diff.", findings: [] },
};
// Implement acts on the first poll; the second stops.
const DEVELOPER_POLLS = 2;
// Verify acts on the first poll; the second waits; the third stops.
const GATEKEEPER_POLLS = 3;
const VERIFY_CHECKOUT = /\/verify-checkout-[^/]+\/repo$/u;
// A project command that records its name, slot and folder outside the
// checkout, in the machine's root beside the pipeline root.
function recording(name: string): string {
  return `printf '%s\\t%s\\t%s\\n' ${name} "$ISSUE_PIPELINE_LANE_SLOT" "$PWD" >> "$ISSUE_PIPELINE_ROOT/../commands.log"`;
}
const RECORD_SETUP = recording("setup");
const RECORD_TEST = recording("test");
const PARTIAL = "warm.partial";
const SETUP_EXIT = 3;
// Polls until the failing run stops: a later poll finds the issue held.
const HELD_POLLS = 3;
const PREPARATION_FAILED = /checkout preparation failed/u;
const SETUP_LOG_EXIT = new RegExp(`--- exit ${String(SETUP_EXIT)} ---`, "u");
// The runtime retains a checkout whose preparation started unconfirmed
// before it would try to remove it; the lane barrier below holds it too.
const PREPARATION_INCOMPLETE = /its preparation started and did not complete/u;

// The operator's own shell slot, which an action must never inherit.
const OPERATOR_SLOT = "ISSUE_PIPELINE_LANE_SLOT";
process.env[OPERATOR_SLOT] = "9";

// What the recording commands observed, one [name, slot, folder] per run.
function commandRuns(box: Machine): string[][] {
  const log = path.join(box.root, "commands.log");
  if (!fs.existsSync(log)) {
    return [];
  }
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

// A failed test keeps its machine, with every log, for inspection.
function keepIfFailed(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`buddy flow machine kept at ${box.root}\n`);
}

function laneStore(box: Machine): unknown {
  const file = path.join(box.pipeline, "runs", SLUG, "lane-slots.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("configured setup, the writing session and its fresh hardening use the issue's leased lane slot, released once its checkout is removed", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    setup: RECORD_SETUP,
  });
  let passed = false;
  try {
    const { status, actions } = await box.runBuddy([COUNTS, HARDENS], 2);
    assert.equal(status, 0);
    const [action] = actions;
    assert.ok(action !== undefined);
    assert.equal(actions.length, 1);
    assert.deepEqual(
      {
        outcome: action.outcome,
        verdict: action.verdict,
        ownership: action.ownership,
        operations: action.operations.map((item) => [item.op, item.outcome]),
        preserved: action.preserved,
      },
      {
        outcome: "succeeded",
        verdict: "passed",
        ownership: { state: "released", reason: null },
        operations: [
          ["task-attempt", "ok"],
          ["prepare-checkout", "ok"],
          ["checkpoint-action", "ok"],
          ["checkpoint-action", "ok"],
          ["push", "ok"],
          ["open-task-pr", "ok"],
          ["task-result", "ok"],
        ],
        preserved: { checkout: null, patches: [] },
      },
    );
    // Setup ran once for both sessions, in the action's own checkout, with slot 1 of the
    // pool rather than the operator's slot 9.
    const runs = commandRuns(box);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]?.slice(0, 2), ["setup", "1"]);
    assert.ok(
      runs[0]?.[2]?.endsWith(`issue-${ISSUE}-action-${action.id}/repo`),
      `setup ran in ${String(runs[0]?.[2])}`,
    );
    // Both model processes inherited the same leased slot, and the
    // hardening's commit is the head Implement delivered.
    const launches = box.launches();
    assert.deepEqual(
      launches.map((launch) => launch.laneSlot),
      ["1", "1"],
    );
    assert.equal(
      box.git(["show", `agent/issue-${ISSUE}:counter.txt`]),
      "3 widgets, checked",
    );
    // Closing the checkout removed it, its last consumer, and released the
    // slot.
    assert.equal(fs.existsSync(launches[0]?.cwd ?? ""), false);
    assert.deepEqual(laneStore(box), { leases: [], prunedAt: null });
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});

test("a failed setup starts no session and retains the checkout, its untracked work, its slot, its barrier and the issue", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    setup: `${RECORD_SETUP} && printf 'half warm\\n' > ${PARTIAL} && exit ${String(SETUP_EXIT)}`,
  });
  let passed = false;
  try {
    const { status, actions } = await box.runBuddy([COUNTS], HELD_POLLS);
    assert.equal(status, 0);
    assert.equal(actions.length, 1);
    const [action] = actions;
    assert.ok(action !== undefined);
    assert.equal(action.outcome, "unknown");
    assert.match(String(action.reason), PREPARATION_FAILED);
    assert.deepEqual(
      action.operations.map((item) => [item.op, item.outcome]),
      [
        ["task-attempt", "ok"],
        ["prepare-checkout", "failed"],
        ["task-result", "ok"],
      ],
    );
    assert.deepEqual(action.sessions, []);
    assert.deepEqual(box.launches(), []);
    assert.equal(commandRuns(box).length, 1);
    const log = path.join(
      box.pipeline,
      "runs",
      SLUG,
      `issue-${ISSUE}`,
      `setup-${action.id}.log`,
    );
    assert.match(fs.readFileSync(log, "utf8"), SETUP_LOG_EXIT);
    // The physical checkout stays whole, with setup's untracked file.
    const root = action.preserved.checkout;
    assert.ok(root !== null);
    assert.ok(root.endsWith(`issue-${ISSUE}-action-${action.id}`));
    const repo = path.join(root, "repo");
    assert.equal(
      fs.readFileSync(path.join(repo, PARTIAL), "utf8"),
      "half warm\n",
    );
    assert.deepEqual(action.preserved.patches, []);
    // The slot stays leased to the issue with the pending-setup barrier on
    // that checkout, and the issue stays held.
    assert.deepEqual(laneStore(box), {
      leases: [
        { issue: ISSUE, slot: 1, checkouts: [repo], pendingSetup: [repo] },
      ],
      prunedAt: null,
    });
    assert.equal(action.ownership.state, "retained");
    assert.match(String(action.ownership.reason), PREPARATION_INCOMPLETE);
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});

test("Implement, Verify's checks and Verify's review session each use the issue's leased slot", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    requireCi: false,
    setup: RECORD_SETUP,
    test: RECORD_TEST,
  });
  let passed = false;
  try {
    const developer = await box.runBuddy([COUNTS, HARDENS], DEVELOPER_POLLS, {
      role: "developer",
      tasks: ["implement"],
    });
    assert.equal(developer.status, 0, developer.stderr);
    const gatekeeper = await box.runBuddy([REVIEWS], GATEKEEPER_POLLS, {
      role: "gatekeeper",
      tasks: ["verify"],
    });
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const byTask = new Map(
      gatekeeper.actions.map((action) => [action.task, action]),
    );
    const order = ["implement", "verify"] as const;
    assert.deepEqual(
      order.map((task) => {
        const action = byTask.get(task);
        return [task, action?.verdict, action?.ownership.state];
      }),
      order.map((task) => [task, "passed", "released"]),
    );
    // Implement and Verify each ran setup in their own checkout; Verify's
    // checks ran setup and the test in their own detached checkout. Every
    // one of them, and every model session, got slot 1.
    function actionRepo(task: (typeof order)[number]): string {
      return `issue-${ISSUE}-action-${String(byTask.get(task)?.id)}/repo`;
    }
    const runs = commandRuns(box);
    assert.deepEqual(
      runs.map(([name, slot]) => [name, slot]),
      [
        ["setup", "1"],
        ["setup", "1"],
        ["setup", "1"],
        ["test", "1"],
      ],
    );
    assert.ok(runs[0]?.[2]?.endsWith(actionRepo("implement")));
    assert.ok(runs[1]?.[2]?.endsWith(actionRepo("verify")));
    assert.match(runs[2]?.[2] ?? "", VERIFY_CHECKOUT);
    assert.equal(runs[3]?.[2], runs[2]?.[2]);
    assert.deepEqual(
      box.launches().map((launch) => launch.laneSlot),
      ["1", "1", "1"],
    );
    assert.deepEqual(laneStore(box), { leases: [], prunedAt: null });
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});
