// Completed starts on the buddy runtime, through Implement: after a
// confirmed result, a task removes the start label whose application caused
// it, and only that application. Other labels, durable records and a newer
// application stay; a failed label removal warns without changing the
// result; and an unconfirmed result keeps its label. Only gh (fake-gh.ts)
// and pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { World } from "../../support/signals/fake-github-world.ts";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import { records, results } from "./buddy-flow-review-test-kit.ts";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { HARDENING, HUMAN, ISSUE, machine } from "./buddy-flow-test-kit.ts";

const WRITES: PlannedSession = {
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
const POLLS = 2;

// Issue ISSUE with exactly `labels`, each applied by the human.
function labelled(labels: readonly string[]): (world: World) => void {
  return (world: World): void => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue === undefined) {
      throw new Error(`the world has no issue ${ISSUE}`);
    }
    issue.labels = [...labels];
    issue.events = labels.map((label, at) => ({
      id: world.nextId + at,
      event: "labeled",
      label,
      actor: HUMAN,
      viaApp: false,
      createdAt: "2026-10-25T10:00:00Z",
    }));
    world.nextId += labels.length;
  };
}

function labelsOf(box: Machine): string[] | undefined {
  return box.world().issues.find((item) => item.number === ISSUE)?.labels;
}

test("a task clears only its consumed start label, leaving other labels and durable records", async ({
  signal,
}) => {
  const labels = ["start:implement", "task:label:docs"];
  const box = machine(labelled(labels));
  try {
    const run = await box.runBuddy(
      [WRITES, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "passed");
    const issue = box.world().issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.labels, labels.slice(1));
    assert.ok(
      issue?.events.some(
        (event) =>
          event.event === "unlabeled" &&
          event.label === "start:implement" &&
          event.actor === LANDING,
      ),
    );
    assert.equal(records(box).length, 2);
  } finally {
    box.cleanup();
  }
});

test("a task leaves a newer start application in place when its old request completes", async ({
  signal,
}) => {
  const box = machine(labelled(["start:implement"]));
  try {
    const run = await box.runBuddy(
      [{ ...WRITES, change: "reapply-implement-start" }, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "passed");
    const issue = box.world().issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.labels, ["start:implement"]);
    // Implement's own assignment events follow it, so look only at the
    // start label's.
    const last = issue?.events
      .filter((event) => event.label === "start:implement")
      .at(-1);
    assert.equal(last?.event, "labeled");
    assert.equal(last?.actor, HUMAN);
    assert.equal(results(box).length, 1);
  } finally {
    box.cleanup();
  }
});

test("a label deletion failure warns without changing a task's confirmed result", async ({
  signal,
}) => {
  const box = machine((world) => {
    labelled(["start:implement"])(world);
    world.refuseLabelChanges = true;
  });
  try {
    const run = await box.runBuddy(
      [WRITES, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "passed");
    assert.equal(run.actions[0]?.ownership.state, "released");
    assert.deepEqual(labelsOf(box), ["start:implement"]);
    assert.equal(results(box)[0]?.verdict, "passed");
    assert.ok(run.stderr.includes('"state":"warning"'), run.stderr);
    assert.ok(
      run.stderr.includes("could not clear the completed task's start label"),
      run.stderr,
    );
  } finally {
    box.cleanup();
  }
});

test("a task retains its start label when its result cannot be confirmed", async ({
  signal,
}) => {
  const box = machine(labelled(["start:implement"]));
  try {
    const run = await box.runBuddy(
      [WRITES, { ...HARDENING, change: "posts-fail" }],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "unknown");
    assert.equal(run.actions[0]?.ownership.state, "retained");
    assert.deepEqual(labelsOf(box), ["start:implement"]);
    assert.deepEqual(results(box), []);
  } finally {
    box.cleanup();
  }
});
