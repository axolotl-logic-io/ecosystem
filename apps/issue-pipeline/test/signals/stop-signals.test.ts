// The persistent stop latch through the real inbox: an accepted
// agents:stop latches its issue across polls and label removal, makes
// pending starts inert and refuses new starts, and stopLatch tells an
// unaccepted human stop (unknown) from a machine's (clear).
import assert from "node:assert/strict";
import test from "node:test";
import {
  harness,
  labelledIssue,
  REPO,
  taskAnswers,
} from "./signal-test-kit.ts";

const ISSUE = 12;

test("an accepted stop latches the issue after its label is removed", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "agents:stop", "autumn", 7001));
    world.tasks.push(taskAnswers(ISSUE));
  });
  assert.deepEqual(kit.latch(ISSUE), {
    state: "unknown",
    reason: "agents:stop event 7001 by @autumn is not accepted yet",
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.holds, []);
  assert.deepEqual(inbox.signals, [
    {
      kind: "stop",
      id: `github-label:${REPO}#${ISSUE}:7001`,
      workItem: { repo: REPO, number: ISSUE },
      provenance: {
        route: "human",
        login: "autumn",
        userId: 10,
        organization: "acme",
      },
      recordId: 500,
    },
  ]);
  kit.change((world) => {
    const issue = world.issues[0];
    if (issue !== undefined) {
      issue.labels = [];
      issue.events.push({
        id: 7002,
        event: "unlabeled",
        label: "agents:stop",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T11:00:00Z",
      });
    }
  });
  assert.deepEqual(kit.latch(ISSUE), {
    state: "latched",
    reason: `accepted stop github-label:${REPO}#${ISSUE}:7001 (record 500)`,
  });
  assert.deepEqual(
    kit.poll().signals.map((signal) => signal.kind),
    ["stop"],
  );
});

test("a stop makes a pending start inert and refuses a new start", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", 7001));
    world.tasks.push(taskAnswers(ISSUE));
  });
  const [start] = kit.poll().signals;
  assert.equal(start?.kind, "start");
  kit.change((world) => {
    const issue = world.issues[0];
    if (issue !== undefined) {
      issue.labels.push("agents:stop");
      issue.events.push({
        id: 7002,
        event: "labeled",
        label: "agents:stop",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T11:00:00Z",
      });
    }
  });
  const stopped = kit.poll();
  assert.deepEqual(
    stopped.signals.map((signal) => signal.kind),
    ["stop"],
  );
  assert.deepEqual(kit.requalify(start), {
    status: "revoked",
    reason: `#${ISSUE} is stopped by accepted stop github-label:${REPO}#${ISSUE}:7002 (record 501)`,
  });
  kit.change((world) => {
    const issue = world.issues[0];
    if (issue !== undefined) {
      issue.labels = ["start:implement"];
      issue.events.push(
        {
          id: 7003,
          event: "unlabeled",
          label: "agents:stop",
          actor: "autumn",
          viaApp: false,
          createdAt: "2026-10-25T12:00:00Z",
        },
        {
          id: 7004,
          event: "unlabeled",
          label: "start:implement",
          actor: "autumn",
          viaApp: false,
          createdAt: "2026-10-25T12:01:00Z",
        },
        {
          id: 7005,
          event: "labeled",
          label: "start:implement",
          actor: "autumn",
          viaApp: false,
          createdAt: "2026-10-25T12:02:00Z",
        },
      );
    }
  });
  const restarted = kit.poll();
  assert.deepEqual(
    restarted.signals.map((signal) => signal.kind),
    ["stop"],
  );
  assert.match(
    restarted.holds[0]?.reason ?? "",
    /start:implement event 7005 not accepted: #12 is stopped by accepted stop .*removing agents:stop does not continue work/u,
  );
  assert.equal(kit.posts(), 2);
});

test("a machine's stop label is clear and grants nothing", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "agents:stop", "lawd-dev", 7001));
  });
  assert.deepEqual(kit.latch(ISSUE), {
    state: "clear",
    reason:
      "agents:stop event 7001 grants nothing: @lawd-dev is a configured pipeline account",
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals, []);
  assert.match(
    inbox.holds[0]?.reason ?? "",
    /grants nothing: @lawd-dev is a configured pipeline account/u,
  );
  assert.equal(kit.posts(), 0);
});

test("an issue with no stop is clear, and an unreadable one is unknown", () => {
  const kit = harness((world) => {
    world.issues.push({ ...labelledIssue(ISSUE, "bug", "autumn", 7001) });
  });
  assert.deepEqual(kit.latch(ISSUE), {
    state: "clear",
    reason: "no accepted stop and no agents:stop label",
  });
  kit.change((world) => {
    world.faults.push({
      path: `repos/${REPO}/issues/${ISSUE}/comments`,
      page: null,
      status: 502,
      link: null,
    });
  });
  const latch = kit.latch(ISSUE);
  assert.equal(latch.state, "unknown");
  assert.match(latch.reason, /answered HTTP 502/u);
});
