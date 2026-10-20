// @ts-check
import "./isolated-root-test-kit.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { poll, retryHold } from "../src/assignment/poll.ts";
import { RetryHold, retryTime } from "../src/assignment/retry.ts";
import { ASSIGNMENT, emptyCoordination } from "../src/assignment/schema.ts";
import { workerOf } from "../src/assignment/signals.ts";
import { sweep } from "../src/assignment/worker.ts";
import { ISSUE_STATE, newIssueState } from "../src/state.ts";
import { fakeGithub } from "./assignment/fake-github.mjs";
import { assignmentConfig, START } from "./assignment/world.mjs";

const RATE_LIMIT_RESET = 1_792_454_520;
const SECOND = 1000;
const DAY = 86_400_000;
const FIXTURE_3 = 3;
const FIXTURE_4 = 4;
const FIXTURE_5 = 5;
const FIXTURE_6 = 6;
const FIXTURE_7 = 7;
const FIXTURE_8 = 8;
const FIXTURE_10 = 10;
const FIXTURE_100 = 100;
const FIXTURE_101 = 101;
const FIXTURE_102 = 102;
const FIXTURE_120 = 120;
const EXPECTED_MESSAGE_1 = /missing or ambiguous/u;
const EXPECTED_MESSAGE_2 = /discovery incomplete/u;
const EXPECTED_MESSAGE_3 = /actor provenance/u;
const EXPECTED_MESSAGE_4 = /actor provenance/u;
const EXPECTED_MESSAGE_5 = /author/u;
const EXPECTED_MESSAGE_6 = /prerequisite/u;
const EXPECTED_MESSAGE_7 = /questions/u;
const EXPECTED_MESSAGE_8 = /stop/u;
const EXPECTED_MESSAGE_9 = /cutover/u;
const EXPECTED_MESSAGE_10 = /local-only recovery/u;

test("assignment opt-in validates distinct configurable identities, not model or credential selection", () => {
  const cfg = assignmentConfig();
  assert.equal(workerOf(cfg, "build").login, "builder");
  assert.throws(() => workerOf(cfg, "missing"), EXPECTED_MESSAGE_1);
  assert.equal(
    ASSIGNMENT.safeParse({
      enabled: true,
      workers: [
        { id: "same", login: "one", roles: "development" },
        { id: "same", login: "two", roles: "review" },
      ],
    }).success,
    false,
  );
  assert.equal(
    ASSIGNMENT.safeParse({
      enabled: true,
      workers: [
        { id: "one", login: "same", roles: "development" },
        { id: "two", login: "same", roles: "review" },
      ],
    }).success,
    false,
  );
  assert.equal(
    ISSUE_STATE.safeParse({
      ...newIssueState(1),
      coordination: { status: "active" },
    }).success,
    false,
  );
  assert.equal(cfg.models.author, cfg.models.implementor);
});

test("complete multi-repository discovery follows the second page and never selects an unassigned issue", async () => {
  const first = fakeGithub();
  for (let number = 1; number <= FIXTURE_100; number += 1) {
    first.issue(number, "visitor");
  }
  first.issue(FIXTURE_101);
  first.issue(FIXTURE_102).assignees = [];
  const second = fakeGithub(assignmentConfig("other/project"));
  second.issue(FIXTURE_8);
  await poll(
    [
      { cfg: first.cfg, deps: first.deps() },
      { cfg: second.cfg, deps: second.deps() },
    ],
    "build",
    {
      now: () => first.world.now,
      sleep: () => Promise.reject(new Error("once must not wait")),
      stopped: () => false,
      report: () => {
        throw new Error("unexpected discovery failure");
      },
    },
    true,
  );
  assert.deepEqual(
    first.launches.map((job) => job.issue),
    [FIXTURE_101],
  );
  assert.deepEqual(
    second.launches.map((job) => job.issue),
    [FIXTURE_8],
  );
  assert.ok(first.reads.some((read) => read.includes("page=2")));
  assert.ok(first.notices.get(1)?.includes("author"));
});

test("a saturated pagination budget refuses an incomplete queue before executing any issue", async () => {
  const fake = fakeGithub();
  for (let number = 1; number <= FIXTURE_100; number += 1) {
    fake.issue(number);
  }
  assert.ok(fake.cfg.assignment);
  fake.cfg.assignment.pageBudget = 1;
  await assert.rejects(
    sweep(fake.cfg, "build", fake.deps()),
    EXPECTED_MESSAGE_2,
  );
  assert.equal(fake.launches.length, 0);
});

test("current assignment never supplies its actor and never overrides the issue author", async () => {
  const fake = fakeGithub();
  fake.issue(1, "alice", "visitor");
  fake.issue(2, "alice", "builder");
  fake.issue(FIXTURE_3, "builder", "merger");
  fake.issue(FIXTURE_4, "alice", "merger");
  fake.issue(FIXTURE_5);
  fake.allowed.delete("alice");
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(fake.launches.length, 0);
  fake.allowed.add("alice");
  await sweep(fake.cfg, "build", fake.deps());
  assert.deepEqual(
    fake.launches.map((job) => job.issue),
    [FIXTURE_4, FIXTURE_5],
  );
  assert.match(fake.notices.get(1) ?? "", EXPECTED_MESSAGE_3);
  assert.match(fake.notices.get(2) ?? "", EXPECTED_MESSAGE_4);
  assert.match(fake.notices.get(FIXTURE_3) ?? "", EXPECTED_MESSAGE_5);
});

test("dependency, questions, stop, legacy cutover, role and local-recovery holds leave other assigned work runnable", async () => {
  const fake = fakeGithub();
  fake.issue(1).body = "<!-- agent-pipeline:after 2 -->";
  fake.issue(2).assignees = [];
  for (const number of [
    FIXTURE_3,
    FIXTURE_4,
    FIXTURE_5,
    FIXTURE_6,
    FIXTURE_7,
  ]) {
    fake.issue(number);
  }
  fake.states.set(FIXTURE_3, {
    ...newIssueState(FIXTURE_3),
    asked: { inputs: fake.world.inputs },
    coordination: emptyCoordination(),
  });
  fake.states.set(FIXTURE_4, {
    ...newIssueState(FIXTURE_4),
    stage: "stopped",
    coordination: emptyCoordination(),
  });
  fake.states.set(FIXTURE_5, newIssueState(FIXTURE_5));
  fake.states.set(FIXTURE_6, {
    ...newIssueState(FIXTURE_6),
    coordination: { ...emptyCoordination(), localRecovery: true },
  });
  const result = await sweep(fake.cfg, "build", fake.deps());
  assert.equal(result.executed, 1);
  assert.deepEqual(
    fake.launches.map((job) => job.issue),
    [FIXTURE_7],
  );
  assert.match(fake.notices.get(1) ?? "", EXPECTED_MESSAGE_6);
  assert.match(fake.notices.get(FIXTURE_3) ?? "", EXPECTED_MESSAGE_7);
  assert.match(fake.notices.get(FIXTURE_4) ?? "", EXPECTED_MESSAGE_8);
  assert.match(fake.notices.get(FIXTURE_5) ?? "", EXPECTED_MESSAGE_9);
  assert.match(fake.notices.get(FIXTURE_6) ?? "", EXPECTED_MESSAGE_10);
});

test("idle polling continues and discovers a later assignment within its healthy bound", async () => {
  const fake = fakeGithub();
  let waits = 0;
  await poll([{ cfg: fake.cfg, deps: fake.deps() }], "build", {
    now: () => fake.world.now,
    stopped: () => waits === 2,
    sleep: (ms) => {
      assert.equal(ms, FIXTURE_10 * SECOND);
      fake.world.now += ms;
      waits += 1;
      if (waits === 1) {
        fake.issue(1);
      }
      return Promise.resolve();
    },
    report: () => {
      throw new Error("unexpected failure");
    },
  });
  assert.equal(waits, 2);
  assert.deepEqual(
    fake.launches.map((job) => job.issue),
    [1],
  );
});

test("rate-limit retry timing is durable across replacement without a private queue and incomplete reads do not withdraw work", async () => {
  const fake = fakeGithub();
  fake.issue(1);
  const until = START + DAY;
  const deps = fake.deps();
  const { read } = deps.hub;
  deps.hub = {
    ...deps.hub,
    read: (endpoint) => {
      if (endpoint.startsWith("issues?")) {
        throw new RetryHold("HTTP 429", { until });
      }
      return read(endpoint);
    },
  };
  const clock = {
    now: () => fake.world.now,
    stopped: () => false,
    sleep: () => Promise.resolve(),
    report: () => undefined,
  };
  await poll([{ cfg: fake.cfg, deps }], "build", clock, true);
  assert.equal(retryHold(fake.hub, fake.cfg), until);
  assert.equal(fake.launches.length, 0);
  assert.equal(fake.issues.get(1)?.assignees[0]?.login, "builder");
  await poll([{ cfg: fake.cfg, deps: fake.deps() }], "build", clock, true);
  assert.equal(fake.launches.length, 0);
  fake.world.now = until;
  await poll([{ cfg: fake.cfg, deps: fake.deps() }], "build", clock, true);
  assert.equal(fake.launches.length, 1);
  assert.equal(
    retryTime("Retry-After: 120\r\nX-RateLimit-Reset: 1792454520", START),
    Math.max(START + FIXTURE_120 * SECOND, RATE_LIMIT_RESET * SECOND),
  );
});
