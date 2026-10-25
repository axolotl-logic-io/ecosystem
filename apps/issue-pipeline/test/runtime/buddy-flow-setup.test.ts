// The supported buddy entrypoint with a lane slot pool and a configured
// setup command: the built buddy.mjs registers Implement's own checkout as
// its issue's lane-slot consumer, runs the pinned setup there through the
// guarded prepare-checkout op with the leased ISSUE_PIPELINE_LANE_SLOT, and
// the writer session inherits that slot, never the operator's own. A failed
// setup starts no session, retains the checkout, its untracked work, its
// slot and its readiness barrier, and holds the issue so nothing replays.
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
// Setup records the slot and folder it ran with outside the checkout, in
// the machine's root beside the pipeline root.
const RECORD_SETUP = `printf '%s\\t%s\\n' "$ISSUE_PIPELINE_LANE_SLOT" "$PWD" >> "$ISSUE_PIPELINE_ROOT/../setup.log"`;
const PARTIAL = "warm.partial";
const SETUP_EXIT = 3;
// Polls until the failing run stops: a later poll finds the issue held.
const HELD_POLLS = 3;
const PREPARATION_FAILED = /checkout preparation failed/u;
const SETUP_LOG_EXIT = new RegExp(`--- exit ${String(SETUP_EXIT)} ---`, "u");
const SETUP_INCOMPLETE = /lane setup is incomplete/u;

// The operator's own shell slot, which an action must never inherit.
const OPERATOR_SLOT = "ISSUE_PIPELINE_LANE_SLOT";
process.env[OPERATOR_SLOT] = "9";

// What setup observed, one [slot, folder] per run.
function setupRuns(box: Machine): string[][] {
  const log = path.join(box.root, "setup.log");
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

test("configured setup and the writer session use the issue's leased lane slot, released once its checkout is removed", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    setup: RECORD_SETUP,
  });
  let passed = false;
  try {
    const { status, actions } = await box.runBuddy([COUNTS], 2);
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
          ["push", "ok"],
          ["open-task-pr", "ok"],
          ["task-result", "ok"],
        ],
        preserved: { checkout: null, patches: [] },
      },
    );
    // Setup ran once, in the action's own checkout, with slot 1 of the
    // pool rather than the operator's slot 9.
    const runs = setupRuns(box);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.[0], "1");
    assert.ok(
      runs[0]?.[1]?.endsWith(`issue-${ISSUE}-action-${action.id}/repo`),
      `setup ran in ${String(runs[0]?.[1])}`,
    );
    // The model process inherited the same leased slot.
    const launches = box.launches();
    assert.deepEqual(
      launches.map((launch) => launch.laneSlot),
      ["1"],
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
    assert.equal(setupRuns(box).length, 1);
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
    assert.match(String(action.ownership.reason), SETUP_INCOMPLETE);
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});
