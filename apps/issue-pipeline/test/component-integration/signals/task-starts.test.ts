// Starts through the real inbox, fake gh and a local bare origin:
// start:implement requests Implement for the issue's current requirements;
// start:verify, start:fix and start:land request their task for the current
// head of the issue's linked PR; a fresh start after an interrupted run
// requests a retry that continues it. Each start is spent only by an attempt
// of its own task. start:gherkin belongs to the Gherkin task app, which the
// buddy runtime doesn't run.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  HumanProvenance,
  Revision,
  TargetState,
  WorkItemRef,
} from "../../../src/domain.ts";
import type { TaskAnswers } from "../../support/signals/fake-github-world.ts";
import {
  COMMIT,
  harness,
  labelledIssue,
  mentions,
  OTHER_COMMIT,
  openPull,
  REPO,
  REQUIREMENTS,
  records,
  taskAnswers,
} from "../../support/signals/signal-test-kit.ts";

const ISSUE = 21;
const PR = 31;
const EVENT = 8001;
const SECOND_EVENT = 8002;
const REMOVED_EVENT = 8003;
const REAPPLIED_EVENT = 8004;
const RECORD = 500;
const EARLIER = `github-label:${REPO}#${ISSUE}:1`;
const SHA256_HEX = 64;
const WORK_ITEM: WorkItemRef = { repo: REPO, number: ISSUE };
const TARGET: TargetState = {
  branch: `agent/issue-${ISSUE}`,
  commit: COMMIT,
};
const AUTUMN: HumanProvenance = {
  route: "human",
  login: "autumn",
  userId: 10,
  organization: "acme",
};
const REVISION: Revision = {
  code: OTHER_COMMIT,
  inputs: "c".repeat(SHA256_HEX),
  policy: "d".repeat(SHA256_HEX),
};

type Cause = TaskAnswers["causes"][number];

// An attempt of `task` on ISSUE's current requirements, caused by `signal`.
function requirementsAttempt(task: "implement", signal: string): Cause {
  return {
    binding: {
      workItem: WORK_ITEM,
      task,
      target: TARGET,
      requirements: REQUIREMENTS,
    },
    cause: { signal, recordId: RECORD },
  };
}

// An attempt of revision task `task` on ISSUE, caused by `signal`.
function revisionAttempt(
  task: "verify" | "fix" | "land",
  signal: string,
): Cause {
  return {
    binding: { workItem: WORK_ITEM, task, target: TARGET, revision: REVISION },
    cause: { signal, recordId: RECORD },
  };
}

function setCauses(
  kit: ReturnType<typeof harness>,
  causes: readonly Cause[],
): void {
  kit.change((world) => {
    const [answers] = world.tasks;
    if (answers !== undefined) {
      answers.causes = [...causes];
    }
  });
}

test("a member's start:implement is accepted for the current requirements", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    world.tasks.push(taskAnswers(ISSUE));
  });
  const id = `github-label:${REPO}#${ISSUE}:${EVENT}`;
  const first = kit.poll();
  assert.deepEqual(first.holds, []);
  assert.deepEqual(first.signals, [
    {
      kind: "start",
      id,
      workItem: WORK_ITEM,
      task: "implement",
      requirements: REQUIREMENTS,
      target: TARGET,
      provenance: AUTUMN,
      recordId: RECORD,
    },
  ]);
  const [record] = records(kit.world(), ISSUE);
  assert.deepEqual(record, {
    version: 2,
    kind: "accepted",
    id,
    workItem: WORK_ITEM,
    source: {
      kind: "github-label",
      label: "start:implement",
      event: {
        id: EVENT,
        nodeId: `LE_${EVENT}`,
        createdAt: "2026-10-25T10:00:00Z",
      },
    },
    producer: AUTUMN,
    request: {
      kind: "start",
      task: "implement",
      requirements: REQUIREMENTS,
      target: TARGET,
    },
    acceptedBy: { buddyRun: "6f1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11" },
  });
  // Another task's attempt naming the start doesn't spend it.
  setCauses(kit, [revisionAttempt("verify", id)]);
  assert.deepEqual(kit.poll().signals, first.signals);
  assert.deepEqual(
    kit.requalifyNow({ id, recordId: RECORD, workItem: WORK_ITEM }),
    {
      status: "qualified",
      reason: "@autumn (user 10) is an active member of acme",
    },
  );
  setCauses(kit, [requirementsAttempt("implement", id)]);
  const spent = kit.poll();
  assert.deepEqual(spent.signals, []);
  assert.deepEqual(spent.holds, []);
  assert.equal(kit.posts(), 1);
});

for (const label of ["start:gherkin", "start:author"]) {
  test(`${label} is no start of the buddy runtime: its inbox records, delivers and holds nothing`, () => {
    const kit = harness((world) => {
      world.issues.push(labelledIssue(ISSUE, label, "autumn", EVENT));
      world.tasks.push(taskAnswers(ISSUE));
    });
    const inbox = kit.poll();
    assert.deepEqual(inbox.signals, []);
    assert.deepEqual(inbox.holds, []);
    assert.equal(kit.posts(), 0);
  });
}

test("start:verify requests Verify for the linked PR's head when accepted", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:verify", "autumn", EVENT));
    world.tasks.push(taskAnswers(ISSUE));
    world.pulls = [openPull(ISSUE, PR)];
  });
  const head = kit.push(ISSUE);
  const id = `github-label:${REPO}#${ISSUE}:${EVENT}`;
  const first = kit.poll();
  assert.deepEqual(first.holds, []);
  const start = {
    kind: "start",
    id,
    workItem: WORK_ITEM,
    task: "verify",
    pr: PR,
    head,
    target: TARGET,
    provenance: AUTUMN,
    recordId: RECORD,
  };
  assert.deepEqual(first.signals, [start]);
  const [record] = records(kit.world(), ISSUE);
  assert.deepEqual(record, {
    version: 2,
    kind: "accepted",
    id,
    workItem: WORK_ITEM,
    source: {
      kind: "github-label",
      label: "start:verify",
      event: {
        id: EVENT,
        nodeId: `LE_${EVENT}`,
        createdAt: "2026-10-25T10:00:00Z",
      },
    },
    producer: AUTUMN,
    request: { kind: "start", task: "verify", pr: PR, head, target: TARGET },
    acceptedBy: { buddyRun: "6f1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11" },
  });
  // A later push doesn't rewrite what was accepted: the task lane decides
  // whether the requested head is still current.
  kit.push(ISSUE);
  assert.deepEqual(kit.poll().signals, [start]);
  assert.equal(kit.requalify(start).status, "qualified");
  setCauses(kit, [requirementsAttempt("implement", id)]);
  assert.deepEqual(kit.poll().signals, [start]);
  setCauses(kit, [revisionAttempt("verify", id)]);
  assert.deepEqual(kit.poll().signals, []);
  assert.equal(kit.posts(), 1);
});

for (const task of ["fix", "land"] as const) {
  test(`start:${task} requests ${task} for the linked PR's head and only ${task}'s attempt spends it`, () => {
    const kit = harness((world) => {
      world.issues.push(labelledIssue(ISSUE, `start:${task}`, "autumn", EVENT));
      world.tasks.push(taskAnswers(ISSUE));
      world.pulls = [openPull(ISSUE, PR)];
    });
    const head = kit.push(ISSUE);
    const id = `github-label:${REPO}#${ISSUE}:${EVENT}`;
    const first = kit.poll();
    assert.deepEqual(first.holds, []);
    const start = {
      kind: "start",
      id,
      workItem: WORK_ITEM,
      task,
      pr: PR,
      head,
      target: TARGET,
      provenance: AUTUMN,
      recordId: RECORD,
    };
    assert.deepEqual(first.signals, [start]);
    assert.partialDeepStrictEqual(records(kit.world(), ISSUE)[0], {
      request: { kind: "start", task, pr: PR, head, target: TARGET },
    });
    setCauses(kit, [revisionAttempt("verify", id)]);
    assert.deepEqual(kit.poll().signals, [start]);
    setCauses(kit, [revisionAttempt(task, id)]);
    assert.deepEqual(kit.poll().signals, []);
    assert.equal(kit.posts(), 1);
  });
}

// ISSUE's interrupted Implement run of its current requirements, caused by
// an earlier start.
function interrupted(): TaskAnswers["view"]["results"] {
  return [
    {
      binding: {
        workItem: WORK_ITEM,
        task: "implement",
        target: TARGET,
        requirements: REQUIREMENTS,
      },
      run: { id: "0b6d7c4e-1c1a-4f7e-9f61-5d0f2b7a9c31", previous: null },
      buddyRun: "6f1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11",
      cause: { signal: EARLIER, recordId: 1 },
      verdict: "failed",
      receipt: {
        summary: "interrupted",
        evidence: {
          interrupted: {
            branch: `agent/issue-${ISSUE}`,
            head: null,
            continues: false,
          },
        },
      },
      recordId: 2,
    },
  ];
}

test("a fresh start:implement after an interrupted run is accepted to continue it", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    const answers = taskAnswers(ISSUE);
    answers.causes = [requirementsAttempt("implement", EARLIER)];
    answers.previous = "0b6d7c4e-1c1a-4f7e-9f61-5d0f2b7a9c31";
    answers.view.results = interrupted();
    world.tasks.push(answers);
  });
  const id = `github-label:${REPO}#${ISSUE}:${EVENT}`;
  const accepted = kit.poll();
  assert.deepEqual(accepted.holds, []);
  assert.partialDeepStrictEqual(accepted.signals, [{ id, task: "implement" }]);
  assert.equal(kit.posts(), 1);
});

test("start:verify without an open linked PR holds and records nothing", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:verify", "autumn", EVENT));
    world.tasks.push(taskAnswers(ISSUE));
  });
  const none = kit.poll();
  assert.deepEqual(none.signals, []);
  assert.equal(none.complete, true);
  assert.match(
    none.holds[0]?.reason ?? "",
    mentions(
      `start:verify event ${EVENT} not accepted: #${ISSUE} has no linked PR to verify`,
    ),
  );
  kit.push(ISSUE);
  kit.change((world) => {
    world.pulls = [{ ...openPull(ISSUE, PR), state: "CLOSED" }];
  });
  const closed = kit.poll();
  assert.deepEqual(closed.signals, []);
  assert.match(
    closed.holds[0]?.reason ?? "",
    mentions(`PR #${PR} is CLOSED, so it has no head to verify`),
  );
  assert.equal(kit.posts(), 0);
});

test("a stop refuses start:verify and makes an accepted one inert", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:verify", "autumn", EVENT));
    world.tasks.push(taskAnswers(ISSUE));
    world.pulls = [openPull(ISSUE, PR)];
  });
  kit.push(ISSUE);
  const [start] = kit.poll().signals;
  kit.change((world) => {
    const [issue] = world.issues;
    if (issue !== undefined) {
      issue.labels.push("agents:stop");
      issue.events.push({
        id: SECOND_EVENT,
        event: "labeled",
        label: "agents:stop",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T10:05:00Z",
      });
    }
  });
  const stopped = kit.poll();
  assert.deepEqual(
    stopped.signals.map((signal) => signal.kind),
    ["stop"],
  );
  assert.equal(kit.requalify(start).status, "revoked");
  kit.change((world) => {
    world.issues[0]?.events.push(
      {
        id: REMOVED_EVENT,
        event: "unlabeled",
        label: "start:verify",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T10:06:00Z",
      },
      {
        id: REAPPLIED_EVENT,
        event: "labeled",
        label: "start:verify",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T10:07:00Z",
      },
    );
  });
  const refused = kit.poll();
  assert.deepEqual(
    refused.signals.map((signal) => signal.kind),
    ["stop"],
  );
  assert.match(
    refused.holds[0]?.reason ?? "",
    mentions(
      `start:verify event ${REAPPLIED_EVENT} not accepted: #${ISSUE} is stopped`,
    ),
  );
  assert.equal(kit.posts(), 2);
});
