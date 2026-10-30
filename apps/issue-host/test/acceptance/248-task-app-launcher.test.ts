// Issue #248's scenarios, one test each, run against the buddy itself as a
// launcher, with the sample task app installed as each task's app and fake
// GitHub.
//
// Feature: The buddy launches task apps from start labels
//
//   Scenario: A buddy launches the app of each of its tasks it sees a start of
//     Given `start:gherkin`, `start:implement` and `start:verify` are on the issue
//     And each of the three tasks has an installed app
//     When a buddy responsible for Gherkin and Implement runs
//     Then the Gherkin and Implement apps each do their work once
//     And `start:verify` stays on the issue, and the Verify app never runs
//
//   Scenario: Two buddies with the same task race for one start
//     Given `start:verify` is on the issue
//     When two buddies responsible for Verify, each with its own account, run
//     Then exactly one of them runs the Verify work
//
//   Scenario: A start applied again during a live run starts a second run
//     Given a buddy's Verify run is live
//     When a person applies `start:verify` again
//     Then the buddy launches a second Verify run while the first is live
//
//   Scenario: The buddy keeps running when an app fails
//     Given the Verify app's work fails
//     When a person applies `start:verify`, and again after the run failed
//     Then the buddy launches the app both times and logs each exit status
//     And the app's comments report each failure
//
//   Scenario: Two buddies configured with the same account
//     Given another buddy file in the buddy's folder names its account
//     When the buddy starts
//     Then it refuses to start and names the other file
//     And it launches nothing
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { World } from "../support/signals/fake-github-world.ts";
import {
  type AppExit,
  apply,
  BUDDIES,
  type BuddyRun,
  ISSUE,
  issueOf,
  machine,
  marked,
  REPO,
} from "../support/task-app/task-app-test-kit.ts";

const ISSUE_REF = `${REPO}#${ISSUE}`;
const SAME_ACCOUNT = /is configured with the same account @hippy-dev/u;
const FAILED = /Task `verify` failed at its work step/u;

function succeeded(task: string): (exit: AppExit) => boolean {
  return (exit: AppExit): boolean => exit.task === task && exit.exit === 0;
}

// The Verify labels on the issue.
function verifyLabels(world: World): string[] {
  return issueOf(world).labels.filter((label) => label.includes("verify"));
}

// Resolves once `buddy` has logged `count` failed exits of `task`.
function failures(
  buddy: BuddyRun,
  task: string,
  count: number,
): Promise<AppExit> {
  return buddy.exit(
    () =>
      buddy.exits().filter((exit) => exit.task === task && exit.exit === 1)
        .length >= count,
  );
}

test("Scenario: A buddy launches the app of each of its tasks it sees a start of", async () => {
  const box = machine((world) => {
    apply(world, "start:gherkin");
    apply(world, "start:implement");
    apply(world, "start:verify");
  });
  try {
    for (const task of ["gherkin", "implement", "verify"]) {
      box.install(task);
    }
    const buddy = box.launch("hippy", { tasks: ["gherkin", "implement"] });
    await buddy.exit(succeeded("gherkin"));
    await buddy.exit(succeeded("implement"));
    const ended = await buddy.stop();
    assert.equal(ended.status, 0, ended.stderr);
    const world = box.world();
    for (const task of ["gherkin", "implement"]) {
      assert.equal(marked(world, "note", task).length, 1, task);
      assert.equal(marked(world, "end", task).length, 1, task);
    }
    assert.ok(issueOf(world).labels.includes("start:verify"));
    assert.equal(marked(world, "end", "verify").length, 0);
    assert.ok(buddy.exits().every((exit) => exit.task !== "verify"));
    assert.ok(buddy.exits().every((exit) => exit.issue === ISSUE_REF));
  } finally {
    box.cleanup();
  }
});

test("Scenario: Two buddies with the same task race for one start", async () => {
  const box = machine((world) => {
    apply(world, "start:verify");
  });
  try {
    box.install("verify");
    // Both buddies' apps wait at one gate, which only a winning run reaches.
    const gate = box.gate();
    const hippy = box.launch("hippy", { tasks: ["verify"], gate });
    const lawd = box.launch("lawd", { tasks: ["verify"], gate });
    gate.ready();
    gate.release();
    const ended = await Promise.all([hippy.stop(), lawd.stop()]);
    for (const end of ended) {
      assert.equal(end.status, 0, end.stderr);
    }
    const world = box.world();
    const notes = marked(world, "note", "verify");
    assert.equal(notes.length, 1);
    assert.equal(marked(world, "end", "verify").length, 1);
    const accounts: string[] = Object.values(BUDDIES);
    assert.ok(accounts.includes(notes[0]?.author ?? ""));
    assert.deepEqual(verifyLabels(world), []);
  } finally {
    box.cleanup();
  }
});

test("Scenario: A start applied again during a live run starts a second run", async () => {
  const box = machine((world) => {
    apply(world, "start:verify");
  });
  try {
    box.install("verify");
    const gate = box.gate();
    const buddy = box.launch("hippy", { tasks: ["verify"], gate });
    gate.ready();
    box.change((changed) => {
      apply(changed, "start:verify");
    });
    // The second run reaches the gate while the first still waits at it;
    // one release lets both go on.
    gate.ready();
    assert.equal(marked(box.world(), "note", "verify").length, 0);
    gate.release();
    const ended = await buddy.stop();
    assert.equal(ended.status, 0, ended.stderr);
    const world = box.world();
    assert.equal(marked(world, "note", "verify").length, 2);
    assert.equal(marked(world, "end", "verify").length, 2);
    assert.deepEqual(verifyLabels(world), []);
  } finally {
    box.cleanup();
  }
});

test("Scenario: The buddy keeps running when an app fails", async () => {
  const box = machine((world) => {
    apply(world, "start:verify");
  });
  try {
    box.install("verify");
    const buddy = box.launch("hippy", {
      tasks: ["verify"],
      fail: "the checks went away",
    });
    await failures(buddy, "verify", 1);
    box.change((changed) => {
      apply(changed, "start:verify");
    });
    await failures(buddy, "verify", 2);
    const ended = await buddy.stop();
    assert.equal(ended.status, 0, ended.stderr);
    const ends = marked(box.world(), "end", "verify");
    assert.equal(ends.length, 2);
    assert.ok(ends.every((comment) => FAILED.test(comment.body)));
  } finally {
    box.cleanup();
  }
});

test("Scenario: Two buddies configured with the same account", async () => {
  const box = machine((world) => {
    apply(world, "start:verify");
  });
  try {
    box.install("verify");
    const other = path.join(box.root, "hippy-again.json");
    fs.copyFileSync(box.buddyFile("hippy", ["verify"]), other);
    const ended = await box.launch("hippy", { tasks: ["verify"] }).exited;
    assert.equal(ended.status, 1);
    assert.match(ended.stderr, SAME_ACCOUNT);
    assert.ok(ended.stderr.includes(other));
    const world = box.world();
    assert.ok(issueOf(world).labels.includes("start:verify"));
    assert.equal(issueOf(world).comments.length, 0);
  } finally {
    box.cleanup();
  }
});
