// Issue #246's scenarios, one test each, run against the sample task app
// on the task app framework and fake GitHub.
//
// Feature: Task apps start only from race-safe start-label claims
//
//   Scenario: Two buddies race for one start
//     Given `start:sample` is on the issue
//     When two buddies run the sample task app at once
//     Then exactly one of them does the work and posts an end comment
//     And neither label is left on the issue
//
//   Scenario: A start applied again during a live run starts a second run
//     Given a run of the sample task is live
//     When a person applies `start:sample` again and a buddy runs the app
//     Then the second run does its work while the first is still live
//
//   Scenario: Overlapping runs where the first run ends first
//     Given two live runs of the sample task
//     When the first run ends
//     Then `agent:sample:running` stays until the second run ends too
//
//   Scenario: Overlapping runs where the second run ends first
//     Given two live runs of the sample task
//     When the second run ends
//     Then `agent:sample:running` stays until the first run ends too
//
//   Scenario: A crashed run leaves the running label for a person
//     Given a run of the sample task crashed during its work
//     When later runs end
//     Then `agent:sample:running` stays on the issue
//     And once a person removes it, later runs remove it as they end
//
//   Scenario: agents:stop before a run holds the start
//     Given `agents:stop` and `start:sample` are on the issue
//     When a buddy runs the sample task app
//     Then it claims nothing and `start:sample` stays
//     And once a person removes `agents:stop`, the next run does the work
//
//   Scenario: agents:stop during a run ends it
//     Given a run of the sample task is live
//     When a person applies `agents:stop`
//     Then the run ends before its next write with a stopped comment
//     And `agent:sample:running` is removed
//
//   Scenario: A failed run's comment says how to retry
//     Given the sample task's work fails
//     When a buddy runs the sample task app
//     Then its comment names the task, the failed step and the error
//     And it says to apply `start:sample` again, without applying it
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AppRun,
  apply,
  BUDDIES,
  issueOf,
  type Machine,
  machine,
  marked,
  remove,
} from "../support/task-app/task-app-test-kit.ts";

const START = "start:sample";
const RUNNING = "agent:sample:running";
const STOP = "agents:stop";
const STOPPED_AT_WORK = /stopped at its work step/u;
const STOP_NAMED = /`agents:stop` is on the issue/u;
const FAILED_AT_WORK = /Task `sample` failed at its work step/u;
const ERROR_NAMED = /the model went away/u;
const RETRY = /To retry, apply `start:sample` again\./u;

// What a person sees after one run of an overlapping pair ends.
interface Seen {
  status: number | null;
  ends: number;
  labels: string[];
}

function labels(box: Machine): string[] {
  return issueOf(box.world()).labels;
}

test("Scenario: Two buddies race for one start", async () => {
  const box = machine();
  try {
    const ends = await Promise.all([
      box.runToEnd("hippy"),
      box.runToEnd("lawd"),
    ]);
    assert.deepEqual(
      ends.map((ended) => ended.status),
      [0, 0],
    );
    const world = box.world();
    assert.equal(marked(world, "note").length, 1);
    const [end, ...others] = marked(world, "end");
    assert.deepEqual(others, []);
    assert.equal(end?.author, marked(world, "note")[0]?.author);
    assert.deepEqual(labels(box), []);
  } finally {
    box.cleanup();
  }
});

test("Scenario: A start applied again during a live run starts a second run", async () => {
  const box = machine();
  try {
    const first = box.run("hippy", { gate: true });
    first.ready();
    box.change((world) => apply(world, START));
    const second = box.run("lawd", { gate: true });
    second.ready();
    assert.deepEqual(labels(box), [RUNNING]);
    second.release();
    first.release();
    const ends = await Promise.all([first.exited, second.exited]);
    assert.deepEqual(
      ends.map((ended) => ended.status),
      [0, 0],
    );
    const authors = marked(box.world(), "note").map((note) => note.author);
    assert.deepEqual(
      authors.sort((a, b) => a.localeCompare(b)),
      [BUDDIES.hippy, BUDDIES.lawd],
    );
  } finally {
    box.cleanup();
  }
});

// Lets `run` end and says what a person then sees.
async function endRun(box: Machine, run: AppRun): Promise<Seen> {
  run.release();
  const { status } = await run.exited;
  return {
    status,
    ends: marked(box.world(), "end").length,
    labels: labels(box),
  };
}

// Holds two overlapping runs live, then ends them in turn, the first-started
// one first when `firstEndsFirst`, saying what a person sees after each.
async function overlapping(
  box: Machine,
  firstEndsFirst: boolean,
): Promise<[Seen, Seen]> {
  const first = box.run("hippy", { gate: true });
  first.ready();
  box.change((world) => apply(world, START));
  const second = box.run("lawd", { gate: true });
  second.ready();
  let [early, late] = [second, first];
  if (firstEndsFirst) {
    [early, late] = [first, second];
  }
  const seenEarly = await endRun(box, early);
  return [seenEarly, await endRun(box, late)];
}

test("Scenario: Overlapping runs where the first run ends first", async () => {
  const box = machine();
  try {
    const [early, late] = await overlapping(box, true);
    assert.deepEqual(early, { status: 0, ends: 1, labels: [RUNNING] });
    assert.deepEqual(late, { status: 0, ends: 2, labels: [] });
  } finally {
    box.cleanup();
  }
});

test("Scenario: Overlapping runs where the second run ends first", async () => {
  const box = machine();
  try {
    const [early, late] = await overlapping(box, false);
    assert.deepEqual(early, { status: 0, ends: 1, labels: [RUNNING] });
    assert.deepEqual(late, { status: 0, ends: 2, labels: [] });
  } finally {
    box.cleanup();
  }
});

test("Scenario: A crashed run leaves the running label for a person", async () => {
  const box = machine();
  try {
    const crashed = box.run("hippy", { gate: true });
    crashed.ready();
    crashed.kill();
    await crashed.exited;
    assert.deepEqual(labels(box), [RUNNING]);
    assert.deepEqual(marked(box.world(), "end"), []);
    box.change((world) => apply(world, START));
    assert.equal((await box.runToEnd("lawd")).status, 0);
    assert.deepEqual(labels(box), [RUNNING]);
    box.change((world) => {
      remove(world, RUNNING);
      apply(world, START);
    });
    assert.equal((await box.runToEnd("hippy")).status, 0);
    assert.deepEqual(labels(box), []);
    assert.equal(marked(box.world(), "note").length, 2);
  } finally {
    box.cleanup();
  }
});

test("Scenario: agents:stop before a run holds the start", async () => {
  const box = machine((world) => apply(world, STOP));
  try {
    assert.equal((await box.runToEnd("hippy")).status, 0);
    assert.deepEqual(labels(box), [START, STOP]);
    assert.deepEqual(issueOf(box.world()).comments, []);
    box.change((world) => remove(world, STOP));
    assert.equal((await box.runToEnd("hippy")).status, 0);
    assert.equal(marked(box.world(), "note").length, 1);
    assert.deepEqual(labels(box), []);
  } finally {
    box.cleanup();
  }
});

test("Scenario: agents:stop during a run ends it", async () => {
  const box = machine();
  try {
    const live = box.run("hippy", { gate: true });
    live.ready();
    box.change((world) => apply(world, STOP));
    live.release();
    assert.equal((await live.exited).status, 0);
    const after = box.world();
    assert.deepEqual(marked(after, "note"), []);
    const [stopped] = marked(after, "end");
    assert.match(stopped?.body ?? "", STOPPED_AT_WORK);
    assert.match(stopped?.body ?? "", STOP_NAMED);
    assert.deepEqual(labels(box), [STOP]);
  } finally {
    box.cleanup();
  }
});

test("Scenario: A failed run's comment says how to retry", async () => {
  const box = machine();
  try {
    const ended = await box.runToEnd("hippy", { fail: "the model went away" });
    assert.equal(ended.status, 1);
    const [failed] = marked(box.world(), "end");
    const body = failed?.body ?? "";
    assert.match(body, FAILED_AT_WORK);
    assert.match(body, ERROR_NAMED);
    assert.match(body, RETRY);
    assert.deepEqual(labels(box), []);
  } finally {
    box.cleanup();
  }
});
