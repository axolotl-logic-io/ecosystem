// The persistent stop latch through the real inbox: an accepted
// agents:stop latches its issue across polls and label removal, makes
// pending starts inert and refuses new starts, and stopLatch tells an
// unaccepted human stop (unknown) from a machine's (clear). stopLatchNow,
// the synchronous guard, answers exactly as stopLatch does.
import assert from "node:assert/strict";
import test from "node:test";
import type { FakeEvent } from "./fake-github-world.ts";
import {
  type Harness,
  harness,
  labelledIssue,
  mentions,
  REPO,
  taskAnswers,
} from "./signal-test-kit.ts";

const ISSUE = 12;
const FIRST_EVENT = 7001;
const SECOND_EVENT = 7002;
const STOP_REMOVED = 7003;
const START_REMOVED = 7004;
const START_REAPPLIED = 7005;
const FIRST_RECORD = 500;
const SECOND_RECORD = 501;

function labelEvent(
  id: number,
  event: "labeled" | "unlabeled",
  label: string,
  createdAt: string,
): FakeEvent {
  return { id, event, label, actor: "autumn", viaApp: false, createdAt };
}

// The latch of ISSUE, read by stopLatch and by stopLatchNow, which must
// agree.
function latches(kit: Harness): unknown[] {
  return [kit.latch(ISSUE), kit.latchNow(ISSUE)];
}

test("an accepted stop latches the issue after its label is removed", () => {
  const kit = harness((world) => {
    world.issues.push(
      labelledIssue(ISSUE, "agents:stop", "autumn", FIRST_EVENT),
    );
    world.tasks.push(taskAnswers(ISSUE));
  });
  const pending = {
    state: "unknown",
    reason: `agents:stop event ${FIRST_EVENT} by @autumn is not accepted yet`,
  };
  assert.deepEqual(latches(kit), [pending, pending]);
  const stopId = `github-label:${REPO}#${ISSUE}:${FIRST_EVENT}`;
  const inbox = kit.poll();
  assert.deepEqual(inbox.holds, []);
  assert.deepEqual(inbox.signals, [
    {
      kind: "stop",
      id: stopId,
      workItem: { repo: REPO, number: ISSUE },
      provenance: {
        route: "human",
        login: "autumn",
        userId: 10,
        organization: "acme",
      },
      recordId: FIRST_RECORD,
    },
  ]);
  kit.change((world) => {
    const [issue] = world.issues;
    if (issue !== undefined) {
      issue.labels = [];
      issue.events.push(
        labelEvent(
          SECOND_EVENT,
          "unlabeled",
          "agents:stop",
          "2026-10-25T11:00:00Z",
        ),
      );
    }
  });
  const latched = {
    state: "latched",
    reason: `accepted stop ${stopId} (record ${FIRST_RECORD})`,
  };
  assert.deepEqual(latches(kit), [latched, latched]);
  assert.deepEqual(
    kit.poll().signals.map((signal) => signal.kind),
    ["stop"],
  );
  assert.deepEqual(
    kit.requalifyNow({
      id: stopId,
      recordId: FIRST_RECORD,
      workItem: { repo: REPO, number: ISSUE },
    }),
    {
      status: "qualified",
      reason: "@autumn (user 10) is an active member of acme",
    },
  );
});

test("a stop makes a pending start inert and refuses a new start", () => {
  const kit = harness((world) => {
    world.issues.push(
      labelledIssue(ISSUE, "start:implement", "autumn", FIRST_EVENT),
    );
    world.tasks.push(taskAnswers(ISSUE));
  });
  const [start] = kit.poll().signals;
  assert.equal(start?.kind, "start");
  kit.change((world) => {
    const [issue] = world.issues;
    if (issue !== undefined) {
      issue.labels.push("agents:stop");
      issue.events.push(
        labelEvent(
          SECOND_EVENT,
          "labeled",
          "agents:stop",
          "2026-10-25T11:00:00Z",
        ),
      );
    }
  });
  const stopped = kit.poll();
  assert.deepEqual(
    stopped.signals.map((signal) => signal.kind),
    ["stop"],
  );
  const revoked = {
    status: "revoked",
    reason: `#${ISSUE} is stopped by accepted stop github-label:${REPO}#${ISSUE}:${SECOND_EVENT} (record ${SECOND_RECORD})`,
  };
  assert.deepEqual(kit.requalify(start), revoked);
  assert.deepEqual(
    kit.requalifyNow({
      id: start?.id,
      recordId: start?.recordId,
      workItem: { repo: REPO, number: ISSUE },
    }),
    revoked,
  );
  kit.change((world) => {
    const [issue] = world.issues;
    if (issue !== undefined) {
      issue.labels = ["start:implement"];
      issue.events.push(
        labelEvent(
          STOP_REMOVED,
          "unlabeled",
          "agents:stop",
          "2026-10-25T12:00:00Z",
        ),
        labelEvent(
          START_REMOVED,
          "unlabeled",
          "start:implement",
          "2026-10-25T12:01:00Z",
        ),
        labelEvent(
          START_REAPPLIED,
          "labeled",
          "start:implement",
          "2026-10-25T12:02:00Z",
        ),
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
    mentions(
      `start:implement event ${START_REAPPLIED} not accepted: #${ISSUE} is stopped by accepted stop`,
      "removing agents:stop does not continue work",
    ),
  );
  assert.equal(kit.posts(), 2);
});

test("a machine's stop label is clear and grants nothing", () => {
  const kit = harness((world) => {
    world.issues.push(
      labelledIssue(ISSUE, "agents:stop", "lawd-dev", FIRST_EVENT),
    );
  });
  const clear = {
    state: "clear",
    reason: `agents:stop event ${FIRST_EVENT} grants nothing: @lawd-dev is a configured pipeline account`,
  };
  assert.deepEqual(latches(kit), [clear, clear]);
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals, []);
  assert.match(
    inbox.holds[0]?.reason ?? "",
    mentions("grants nothing: @lawd-dev is a configured pipeline account"),
  );
  assert.equal(kit.posts(), 0);
});

test("an issue with no stop is clear, and an unreadable one is unknown", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "bug", "autumn", FIRST_EVENT));
  });
  const clear = {
    state: "clear",
    reason: "no accepted stop and no agents:stop label",
  };
  assert.deepEqual(latches(kit), [clear, clear]);
  // Whichever read fails, the latch is unknown, never clear: the comments
  // holding accepted records, the issue's labels, or the events that
  // explain a present agents:stop.
  for (const [path, label] of [
    [`repos/${REPO}/issues/${ISSUE}/comments`, "bug"],
    [`repos/${REPO}/issues/${ISSUE}`, "bug"],
    [`repos/${REPO}/issues/${ISSUE}/events`, "agents:stop"],
  ] as const) {
    const unreadable = harness((world) => {
      world.issues.push(labelledIssue(ISSUE, label, "autumn", FIRST_EVENT));
      world.faults.push({ path, page: null, status: 502, link: null });
    });
    for (const latch of [unreadable.latch(ISSUE), unreadable.latchNow(ISSUE)]) {
      assert.equal(latch.state, "unknown");
      assert.match(latch.reason, mentions("answered HTTP 502"));
    }
  }
});
