// The supported buddy entrypoint closing test environments it could not
// prepare, or may not create: the built buddy.mjs, real ops, a real Git
// origin and the project's own shell commands. Only gh (fake-gh.ts) and pi
// (fake-pi.ts) are fakes.
//
// - Without laneSlots, a failed setup still starts no session, is never
//   replayed and keeps the checkout and the issue.
// - A person's stop while setup runs lets the setup finish but starts no
//   session, and no later poll replays the setup.
// - A configured teardown, which the action runtime does not run yet,
//   refuses an acting test-slot task before it creates any checkout or
//   environment.
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
const HELD_POLLS = 3;
const PARTIAL = "warm.partial";
const SETUP_EXIT = 3;
const PREPARATION_INCOMPLETE = /its preparation started and did not complete/u;
const PREPARATION_FAILED = /checkout preparation failed/u;
const TEARDOWN_REFUSED = /commands\.teardown is configured/u;
const STOP_INTERRUPTED = /^interrupted: stop latch unknown: agents:stop /u;

function recording(name: string): string {
  return `printf '%s\\t%s\\t%s\\n' ${name} "$ISSUE_PIPELINE_LANE_SLOT" "$PWD" >> "$ISSUE_PIPELINE_ROOT/../commands.log"`;
}
const RECORD_SETUP = recording("setup");

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

function keepIfFailed(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`buddy flow machine kept at ${box.root}\n`);
}

function storeFile(box: Machine): string {
  return path.join(box.pipeline, "runs", SLUG, "lane-slots.json");
}

// The job folders of action `id`, of which a refused open makes none.
function jobFolders(box: Machine, id: string): string[] {
  const jobs = path.join(box.pipeline, "work", SLUG, "jobs");
  if (!fs.existsSync(jobs)) {
    return [];
  }
  return fs.readdirSync(jobs).filter((name) => name.includes(id));
}

function issueRunDir(box: Machine): string {
  return path.join(box.pipeline, "runs", SLUG, `issue-${ISSUE}`);
}

test("without laneSlots a failed setup starts no session, is not replayed and retains the checkout and the issue", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
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
    // The one start marker refuses any replay of this action's setup.
    assert.ok(
      fs.existsSync(path.join(issueRunDir(box), `setup-${action.id}.started`)),
    );
    const root = action.preserved.checkout;
    assert.ok(root !== null);
    assert.ok(root.endsWith(`issue-${ISSUE}-action-${action.id}`));
    assert.equal(
      fs.readFileSync(path.join(root, "repo", PARTIAL), "utf8"),
      "half warm\n",
    );
    assert.equal(fs.existsSync(storeFile(box)), false);
    assert.equal(action.ownership.state, "retained");
    assert.match(String(action.ownership.reason), PREPARATION_INCOMPLETE);
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});

const CHECK_MS = 200;

// Whether `ready` came to hold, checked every CHECK_MS, at most `tries`
// times.
async function until(ready: () => boolean, tries: number): Promise<boolean> {
  if (ready()) {
    return true;
  }
  if (tries <= 0) {
    return false;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, CHECK_MS);
  });
  return await until(ready, tries - 1);
}
const SETUP_START_TRIES = 300;

// Setup that records its start, then waits for the test to release it.
const WAITING_SETUP = `${RECORD_SETUP} && i=0 && while [ ! -f "$ISSUE_PIPELINE_ROOT/../release-setup" ] && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done`;
const STOP_SETTLE_MS = 4000;

test("a person's agents:stop during setup starts no session and replays no setup", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    setup: WAITING_SETUP,
  });
  let passed = false;
  try {
    const running = box.runBuddy([COUNTS], HELD_POLLS);
    assert.ok(
      await until(() => commandRuns(box).length === 1, SETUP_START_TRIES),
    );
    // The person stops the issue while its setup runs, as fake-pi's
    // stop-issue change does from a session.
    box.change((world) => {
      const issue = world.issues.find((item) => item.number === ISSUE);
      assert.ok(issue !== undefined);
      issue.labels.push("agents:stop");
      issue.events.push({
        id: world.nextId,
        event: "labeled",
        label: "agents:stop",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T13:00:00Z",
      });
      world.nextId += 1;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, STOP_SETTLE_MS);
    });
    fs.writeFileSync(path.join(box.root, "release-setup"), "");
    const { status, actions } = await running;
    assert.equal(status, 0);
    assert.equal(actions.length, 1);
    const [action] = actions;
    assert.ok(action !== undefined);
    // The running setup was not killed: it finished and cleared its
    // barrier, but the interrupted action started no session.
    assert.equal(action.outcome, "unknown");
    assert.match(String(action.reason), STOP_INTERRUPTED);
    assert.deepEqual(
      action.operations.map((item) => [item.op, item.outcome]),
      [
        ["task-attempt", "ok"],
        ["prepare-checkout", "ok"],
        ["task-result", "ok"],
      ],
    );
    assert.deepEqual(action.sessions, []);
    assert.deepEqual(box.launches(), []);
    // Setup ran once over every poll: the stopped preparation never replays.
    assert.equal(commandRuns(box).length, 1);
    // The prepared checkout closed as the slot's last consumer.
    assert.equal(action.preserved.checkout, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(storeFile(box), "utf8")), {
      leases: [],
      prunedAt: null,
    });
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});

test("a configured teardown refuses an acting test-slot task before it creates a checkout or an environment", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    setup: RECORD_SETUP,
    teardown: recording("teardown"),
  });
  let passed = false;
  try {
    const { status, actions } = await box.runBuddy([COUNTS], HELD_POLLS);
    assert.equal(status, 0);
    assert.equal(actions.length, 1);
    const [action] = actions;
    assert.ok(action !== undefined);
    assert.equal(action.outcome, "unknown");
    assert.match(String(action.reason), TEARDOWN_REFUSED);
    assert.deepEqual(action.operations, []);
    assert.deepEqual(action.sessions, []);
    assert.deepEqual(box.launches(), []);
    // Neither setup nor teardown ran, no slot was leased and no checkout
    // of the action exists.
    assert.deepEqual(commandRuns(box), []);
    assert.equal(fs.existsSync(storeFile(box)), false);
    assert.equal(action.preserved.checkout, null);
    assert.deepEqual(jobFolders(box, action.id), []);
    assert.equal(action.ownership.state, "retained");
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});
