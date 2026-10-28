// The supported buddy entrypoint closing test environments it could not
// prepare, or may not create: the built buddy.mjs, real ops, a real Git
// origin and the project's own shell commands. Only gh (fake-gh.ts) and pi
// (fake-pi.ts) are fakes.
//
// - A setup that fails in Verify's detached checks checkout keeps that
//   checkout, its pending-setup barrier on the issue's lease and the issue,
//   even once the action's own checkout is removed.
// - Without laneSlots, a failed setup still starts no session, is never
//   replayed and keeps the checkout and the issue.
// - A person's stop while setup runs lets the setup finish but starts no
//   session, and no later poll replays the setup.
// - A configured teardown, which the action runtime does not run yet,
//   refuses an acting test-slot task before it creates any checkout or
//   environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import {
  applyStart,
  HARDENING,
  ISSUE,
  machine,
} from "./buddy-flow-test-kit.ts";

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
const REVIEWS: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { summary: "Read the whole diff.", findings: [] },
};
// Implement acts on the first poll; the second stops.
const DEVELOPER_POLLS = 2;
const HELD_POLLS = 3;
const PARTIAL = "warm.partial";
const SETUP_EXIT = 3;
const VERIFY_PARENT = /\/verify-checkout-[^/]+$/u;
const CONSUMERS = /the lane slot still has registered consumers/u;
const PREPARATION_INCOMPLETE = /its preparation started and did not complete/u;
const PREPARATION_FAILED = /checkout preparation failed/u;
const TEARDOWN_REFUSED = /commands\.teardown is configured/u;
const STOP_INTERRUPTED = /^interrupted: stop latch unknown: agents:stop /u;

function recording(name: string): string {
  return `printf '%s\\t%s\\t%s\\n' ${name} "$ISSUE_PIPELINE_LANE_SLOT" "$PWD" >> "$ISSUE_PIPELINE_ROOT/../commands.log"`;
}
const RECORD_SETUP = recording("setup");
// Setup that fails, leaving an untracked file, only in Verify's own
// detached checks checkout.
const FAILS_IN_VERIFY = `${RECORD_SETUP} && case "$PWD" in */verify-checkout-*/repo) printf 'half warm\\n' > ${PARTIAL}; exit ${String(SETUP_EXIT)};; esac`;

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

test("a failed setup in Verify's detached checks checkout retains it, its barrier, its slot and the issue", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    requireCi: false,
    setup: FAILS_IN_VERIFY,
  });
  let passed = false;
  try {
    const developer = await box.runBuddy([COUNTS, HARDENING], DEVELOPER_POLLS, {
      role: "developer",
      tasks: ["implement"],
    });
    assert.equal(developer.status, 0, developer.stderr);
    applyStart(box, "start:verify");
    const gatekeeper = await box.runBuddy([REVIEWS], HELD_POLLS, {
      role: "gatekeeper",
      tasks: ["verify"],
    });
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const verify = gatekeeper.actions.filter((run) => run.task === "verify");
    assert.equal(verify.length, 1);
    const [action] = verify;
    assert.ok(action !== undefined);
    assert.equal(action.outcome, "unknown");
    assert.deepEqual(
      action.operations.map((item) => [item.op, item.outcome]),
      [
        ["task-attempt", "ok"],
        ["prepare-checkout", "ok"],
        ["verify-task", "failed"],
        ["task-result", "ok"],
      ],
    );
    // Setup ran in Implement's checkout, Verify's own checkout and then
    // Verify's detached checks checkout, once each: nothing replayed over
    // the held polls.
    const runs = commandRuns(box);
    assert.deepEqual(
      runs.map(([name, slot]) => [name, slot]),
      [
        ["setup", "1"],
        ["setup", "1"],
        ["setup", "1"],
      ],
    );
    const detached = runs[2]?.[2] ?? "";
    const parent = path.dirname(detached);
    assert.match(parent, VERIFY_PARENT);
    // The detached checkout stays whole, with setup's untracked file,
    // though the action's own checkout was removed.
    assert.equal(
      fs.readFileSync(path.join(detached, PARTIAL), "utf8"),
      "half warm\n",
    );
    assert.equal(action.preserved.checkout, null);
    // The lease outlives the removed action checkout: its barrier still
    // names the detached checkout, and the issue stays held.
    const store = JSON.parse(fs.readFileSync(storeFile(box), "utf8"));
    assert.equal(store.leases.length, 1);
    const [lease] = store.leases;
    assert.equal(lease.issue, ISSUE);
    assert.equal(lease.slot, 1);
    // setup's $PWD is the resolved path; the store keeps the pipeline's.
    assert.deepEqual(
      lease.pendingSetup.map((dir: string) => fs.realpathSync(dir)),
      [fs.realpathSync(detached)],
    );
    assert.equal(action.ownership.state, "retained");
    assert.match(String(action.ownership.reason), CONSUMERS);
    // No review was submitted from an environment that was never prepared.
    assert.deepEqual(box.world().pulls?.[0]?.reviews ?? [], []);
    passed = true;
  } finally {
    keepIfFailed(box, passed);
  }
});

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

// Setup that records its start, then blocks until the test writes the
// release FIFO.
const WAITING_SETUP = `${RECORD_SETUP} && read release < "$ISSUE_PIPELINE_ROOT/../release-setup"`;
// How long the buddy may take to start the setup.
const SETUP_START_MS = 60_000;
const STOP_EVENTS = `repos/acme/widgets/issues/${ISSUE}/events`;

// How many label event reads of the issue the buddy has made.
function stopReads(box: Machine): number {
  return box
    .calls()
    .filter((call) => call.args.some((arg) => arg.startsWith(STOP_EVENTS)))
    .length;
}

// Lets a setup still waiting on `fifo` finish, without waiting for one:
// opened for reading and writing, the FIFO needs no reader to open.
function releaseAnySetup(fifo: string): void {
  const fd = fs.openSync(fifo, "r+");
  fs.writeSync(fd, "go\n");
  fs.closeSync(fd);
}

test("a person's agents:stop during setup starts no session and replays no setup", async () => {
  const box = machine(() => undefined, {
    landPermission: false,
    laneSlots: 2,
    setup: WAITING_SETUP,
  });
  const release = path.join(box.root, "release-setup");
  const made = spawnSync("mkfifo", [release]);
  assert.equal(made.status, 0, String(made.stderr));
  let passed = false;
  try {
    const running = box.runBuddy([COUNTS], HELD_POLLS);
    await box.when(() => commandRuns(box).length === 1, {
      withinMs: SETUP_START_MS,
    });
    // The person stops the issue while its setup runs, as fake-pi's
    // stop-issue change does from a session.
    let readsBefore = 0;
    box.change((world) => {
      readsBefore = stopReads(box);
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
    // The action's stop watch reads the label events after the stop, and
    // decides on them before the buddy can notice the setup end.
    await box.when(() => stopReads(box) > readsBefore);
    // Opening the FIFO for writing waits for the setup to read it.
    await fs.promises.writeFile(release, "go\n");
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
    releaseAnySetup(release);
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
