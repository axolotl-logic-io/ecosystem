// Start signals through the real inbox, gh subprocesses and journal: a
// member's start:implement label is accepted once as an append-only record,
// rediscovered without its label, spent by an Implement attempt, inert once
// Implement attempted its requirements, and never re-requested as a retry.
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMIT,
  harness,
  LANDING,
  labelledIssue,
  OTHER_REQUIREMENTS,
  REPO,
  REQUIREMENTS,
  records,
  taskAnswers,
} from "./signal-test-kit.ts";

const ISSUE = 7;
const EVENT = 9001;
const SIGNAL = `github-label:${REPO}#${ISSUE}:${EVENT}`;

function startWorld(): ReturnType<typeof harness> {
  return harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    world.tasks.push(taskAnswers(ISSUE));
  });
}

test("a member's start label is accepted once and delivered as a start", () => {
  const kit = startWorld();
  const first = kit.poll();
  assert.deepEqual(first.holds, []);
  assert.equal(first.complete, true);
  assert.equal(first.signals.length, 1);
  assert.deepEqual(first.signals[0], {
    kind: "start",
    id: SIGNAL,
    workItem: { repo: REPO, number: ISSUE },
    task: "implement",
    requirements: REQUIREMENTS,
    target: { branch: `agent/issue-${ISSUE}`, commit: COMMIT },
    provenance: {
      route: "human",
      login: "autumn",
      userId: 10,
      organization: "acme",
    },
    recordId: 500,
  });
  const [record] = records(kit.world(), ISSUE);
  assert.deepEqual(record, {
    version: 1,
    kind: "accepted",
    id: SIGNAL,
    workItem: { repo: REPO, number: ISSUE },
    source: {
      kind: "github-label",
      label: "start:implement",
      event: {
        id: EVENT,
        nodeId: `LE_${EVENT}`,
        createdAt: "2026-10-25T10:00:00Z",
      },
    },
    producer: {
      route: "human",
      login: "autumn",
      userId: 10,
      organization: "acme",
    },
    request: {
      kind: "start",
      task: "implement",
      requirements: REQUIREMENTS,
      target: { branch: `agent/issue-${ISSUE}`, commit: COMMIT },
    },
    acceptedBy: { buddyRun: "6f1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11" },
  });
  assert.equal(kit.world().issues[0]?.comments[0]?.author, LANDING);
  assert.deepEqual(kit.journal(ISSUE), []);
  const second = kit.poll();
  assert.deepEqual(second.signals, first.signals);
  assert.equal(kit.posts(), 1);
});

test("an accepted start survives its label's removal and requalifies", () => {
  const kit = startWorld();
  const [start] = kit.poll().signals;
  kit.change((world) => {
    const issue = world.issues[0];
    if (issue !== undefined) {
      issue.labels = [];
      issue.events.push({
        id: EVENT + 1,
        event: "unlabeled",
        label: "start:implement",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T11:00:00Z",
      });
    }
  });
  const after = kit.poll();
  assert.deepEqual(after.signals, [start]);
  assert.deepEqual(after.holds, []);
  assert.deepEqual(kit.requalify(start), {
    status: "qualified",
    reason: "@autumn (user 10) is an active member of acme",
  });
  assert.equal(kit.posts(), 1);
});

test("requalification follows the retained user id, not the label or login", () => {
  const kit = startWorld();
  const [start] = kit.poll().signals;
  kit.change((world) => {
    world.members = world.members.filter((item) => item.login !== "autumn");
  });
  assert.equal(kit.requalify(start).status, "revoked");
  const revoked = kit.poll();
  assert.deepEqual(revoked.signals, []);
  assert.match(
    revoked.holds[0]?.reason ?? "",
    /revoked: @autumn is not a member of acme/u,
  );
  kit.change((world) => {
    // autumn's login now belongs to another account, which is a member.
    world.accounts = world.accounts.map((item) =>
      item.login === "autumn" ? { ...item, login: "autumn-old" } : item,
    );
    world.accounts.push({ login: "autumn", id: 77, type: "User" });
    world.members.push({ login: "autumn", state: "active", role: "member" });
  });
  const verdict = kit.requalify(start);
  assert.equal(verdict.status, "revoked");
  assert.match(verdict.reason, /autumn-old is not a member/u);
});

test("an Implement attempt naming the start spends it, whatever its binding", () => {
  const kit = startWorld();
  const [start] = kit.poll().signals;
  kit.change((world) => {
    const answers = world.tasks[0];
    if (answers !== undefined) {
      answers.causes = [
        {
          binding: {
            workItem: { repo: REPO, number: ISSUE },
            task: "implement",
            target: { branch: "elsewhere", commit: "b".repeat(40) },
            requirements: OTHER_REQUIREMENTS,
          },
          cause: { signal: start?.id ?? "", recordId: 500 },
        },
      ];
    }
  });
  const spent = kit.poll();
  assert.deepEqual(spent.signals, []);
  assert.deepEqual(spent.holds, []);
});

test("a start is inert once Implement attempted its requirements under another cause", () => {
  const kit = startWorld();
  kit.poll();
  kit.change((world) => {
    const answers = world.tasks[0];
    if (answers !== undefined) {
      answers.causes = [
        {
          binding: {
            workItem: { repo: REPO, number: ISSUE },
            task: "implement",
            target: { branch: "moved", commit: "c".repeat(40) },
            requirements: REQUIREMENTS,
          },
          cause: { signal: "github-label:acme/widgets#7:1", recordId: 3 },
        },
      ];
    }
  });
  assert.deepEqual(kit.poll().signals, []);
});

test("reapplying start to attempted requirements holds as an unsupported retry", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    const answers = taskAnswers(ISSUE);
    answers.causes = [
      {
        binding: {
          workItem: { repo: REPO, number: ISSUE },
          task: "implement",
          target: { branch: `agent/issue-${ISSUE}`, commit: COMMIT },
          requirements: REQUIREMENTS,
        },
        cause: { signal: "github-label:acme/widgets#7:1", recordId: 3 },
      },
    ];
    world.tasks.push(answers);
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals, []);
  assert.equal(inbox.holds.length, 1);
  assert.match(
    inbox.holds[0]?.reason ?? "",
    /start:implement event 9001 not accepted: Implement already attempted these requirements .* retrying requirements Implement already attempted is unsupported/u,
  );
  assert.equal(kit.posts(), 0);
});

test("a previous Implement action for the exact binding holds a new start", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    const answers = taskAnswers(ISSUE);
    answers.previous = "0b6c0b5e-6e1f-4a43-8d38-55b3c84a8f01";
    world.tasks.push(answers);
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals, []);
  assert.match(
    inbox.holds[0]?.reason ?? "",
    /already ran for this binding; retrying/u,
  );
  assert.equal(kit.posts(), 0);
});

test("an unreadable task view holds the start and marks the poll incomplete", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    const answers = taskAnswers(ISSUE);
    answers.failure = "task records of #7 conflict";
    world.tasks.push(answers);
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals, []);
  assert.equal(inbox.complete, false);
  assert.match(inbox.holds[0]?.reason ?? "", /task records of #7 conflict/u);
  assert.equal(kit.posts(), 0);
});

test("machine results come from the task lane's authenticated results", () => {
  const kit = startWorld();
  const result = {
    kind: "result" as const,
    id: "task-result:acme/widgets#7:501",
    workItem: { repo: REPO, number: ISSUE },
    binding: {
      workItem: { repo: REPO, number: ISSUE },
      task: "implement" as const,
      target: { branch: `agent/issue-${ISSUE}`, commit: COMMIT },
      requirements: REQUIREMENTS,
    },
    recordId: 501,
    producerRun: "2d0f2c43-5b8f-4c2e-9c0d-0c7f8e0e9a10",
  };
  kit.poll();
  kit.change((world) => {
    const answers = world.tasks[0];
    if (answers !== undefined) {
      answers.machine = [result];
    }
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals.at(-1), result);
  assert.deepEqual(kit.requalify(result), {
    status: "qualified",
    reason: "result record 501 is current",
  });
  kit.change((world) => {
    const answers = world.tasks[0];
    if (answers !== undefined) {
      answers.machine = [];
    }
  });
  assert.equal(kit.requalify(result).status, "revoked");
});
