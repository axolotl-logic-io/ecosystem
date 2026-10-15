// The ci-status op: the PR's required checks, read through a fake gh. Through
// the CLI it pins each gh call and reply; imported with a fake clock it pins the
// waits, with no real time passing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";
import { askRaw } from "./verify-test-kit.mjs";

const root = fs.mkdtempSync("/tmp/issue-pipeline-ci-status-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
process.env.ISSUE_PIPELINE_ROOT = root;
const { ciStatus } = await import("../src/ops/ci-status.ts");
const fakeGh = installFakeGh();

const config = path.join(root, "config.json");
fs.writeFileSync(
  config,
  JSON.stringify({
    repo: "o/r",
    account: "a",
    allowedUsers: ["a"],
    commands: { test: "true" },
  }),
);
const cfg = {
  repo: "o/r",
  account: "a",
  requireCi: true,
  ciWaitMinutes: 30,
  slug: "o__r",
};
const ISSUE = 3;
const PR = 9;
const DIRECT = { number: ISSUE, pr: PR };
const runDir = path.join(root, "runs", "o__r", `issue-${ISSUE}`);
const VIEW = ["pr", "view", String(PR), "-R", "o/r", "--json", "headRefOid"];
const CHECKS = [
  "pr",
  "checks",
  String(PR),
  "-R",
  "o/r",
  "--required",
  "--json",
  "name,state,bucket,link",
];
const HEAD = { when: "pr view", stdout: JSON.stringify({ headRefOid: "abc" }) };
const RUN_LINK = "https://github.com/o/r/actions/runs/555/job/7";
const MS_PER_MINUTE = 60_000;
const POLL_MS = 30_000;

const LOG_NAME = /^ci-\d+\.log$/u;

function checksReply(checks) {
  return { when: "pr checks", stdout: JSON.stringify(checks) };
}

function request(extra) {
  return { op: "ci-status", config, number: ISSUE, pr: PR, ...extra };
}

// The reply as the ops CLI prints it, keys in order.
function reply(extra) {
  return JSON.stringify({ ok: true, op: "ci-status", posted: 0, ...extra });
}

test("a head that moved stops the wait", () => {
  fakeGh.reply([
    { when: "pr view", stdout: JSON.stringify({ headRefOid: "def" }) },
  ]);
  assert.equal(
    askRaw(root, request({ expectedSha: "abc" })),
    `${reply({ status: "head-changed", headSha: "def" })}\n`,
  );
  assert.deepEqual(fakeGh.calls(), [VIEW]);
});

test("required checks that all pass pass, by name", () => {
  const checks = [
    { name: "build", state: "SUCCESS", bucket: "pass", link: "l1" },
    { name: "e2e", state: "SKIPPED", bucket: "skipping", link: "l2" },
  ];
  fakeGh.reply([HEAD, checksReply(checks)]);
  assert.equal(
    askRaw(root, request({ expectedSha: "abc" })),
    `${reply({ status: "pass", checks: ["build", "e2e"] })}\n`,
  );
  assert.deepEqual(fakeGh.calls(), [VIEW, CHECKS]);
});

test("failing checks fail, with each one's failed log in one file", () => {
  const checks = [
    { name: "build", state: "FAILURE", bucket: "fail", link: RUN_LINK },
    { name: "deploy", state: "CANCELLED", bucket: "cancel" },
    { name: "lint", state: "SUCCESS", bucket: "pass", link: "l3" },
  ];
  fakeGh.reply([
    HEAD,
    checksReply(checks),
    { when: "run view 555", stdout: "step 1\nboom\n" },
  ]);
  const raw = askRaw(root, request({}));
  const got = JSON.parse(raw);
  assert.equal(
    raw,
    `${reply({ status: "fail", failing: ["build", "deploy"], logPath: got.logPath })}\n`,
  );
  assert.equal(path.dirname(got.logPath), runDir);
  assert.match(path.basename(got.logPath), LOG_NAME);
  assert.equal(
    fs.readFileSync(got.logPath, "utf8"),
    `===== build (${RUN_LINK}) =====\nstep 1\nboom\n\n===== deploy (undefined) =====`,
  );
  assert.deepEqual(fakeGh.calls(), [
    VIEW,
    CHECKS,
    ["run", "view", "555", "-R", "o/r", "--log-failed"],
  ]);
});

// A clock where each sleep moves the time on by its length.
function fakeClock() {
  const sleeps = [];
  let time = 0;
  return {
    sleeps,
    now: () => time,
    sleep: (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

// Polls ending 3 minutes and one poll in, every 30 s, with no checks.
const GRACE_POLLS = 8;
// Polls up to the deadline of a 1-minute wait: at 0, 30, 60 and 90 s.
const DEADLINE_POLLS = 4;
const WAIT_MINUTES = 2;

function pollCalls(rounds) {
  return Array.from({ length: rounds }, () => [VIEW, CHECKS]).flat();
}

for (const [output, label] of [
  ["", "nothing"],
  ["not json", "not JSON"],
  ['{"name":"x"}', "not an array"],
  ["[]", "no checks"],
]) {
  test(`checks that print ${label} for 3 minutes give no-checks when CI is required`, () => {
    fakeGh.reply(
      Array.from({ length: GRACE_POLLS }, () => ({
        when: "pr checks",
        stdout: output,
      })),
    );
    const clock = fakeClock();
    assert.deepEqual(ciStatus(cfg, DIRECT, clock), {
      status: "no-checks",
      checks: [],
    });
    assert.deepEqual(
      clock.sleeps,
      Array.from({ length: GRACE_POLLS - 1 }, () => POLL_MS),
    );
    assert.deepEqual(fakeGh.calls(), pollCalls(GRACE_POLLS));
  });
}

test("no checks for 3 minutes pass when CI isn't required", () => {
  fakeGh.reply([]);
  const clock = fakeClock();
  assert.deepEqual(ciStatus({ ...cfg, requireCi: false }, DIRECT, clock), {
    status: "pass",
    checks: [],
  });
  assert.deepEqual(clock.sleeps.length, GRACE_POLLS - 1);
});

test("checks still pending at the deadline give pending", () => {
  const pending = checksReply([
    { name: "build", state: "PENDING", bucket: "pending", link: "l" },
  ]);
  fakeGh.reply(Array.from({ length: DEADLINE_POLLS }, () => pending));
  const clock = fakeClock();
  assert.deepEqual(ciStatus(cfg, { ...DIRECT, waitMinutes: 1 }, clock), {
    status: "pending",
  });
  // At 0, 30 and 60 s the deadline (60 s) hasn't passed; at 90 s it has.
  assert.deepEqual(clock.sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  assert.deepEqual(fakeGh.calls(), pollCalls(DEADLINE_POLLS));
});

test("the config's wait applies when the request names none", () => {
  fakeGh.reply([]);
  const clock = fakeClock();
  const got = ciStatus({ ...cfg, ciWaitMinutes: WAIT_MINUTES }, DIRECT, clock);
  // With no checks the 3-minute grace outlasts a 2-minute wait.
  assert.deepEqual(got, { status: "pending" });
  assert.equal(clock.now(), WAIT_MINUTES * MS_PER_MINUTE + POLL_MS);
});

test("a failing check's log is named by the clock's time", () => {
  fakeGh.reply([
    HEAD,
    checksReply([
      { name: "build", state: "FAILURE", bucket: "fail", link: "l" },
    ]),
  ]);
  const got = ciStatus(cfg, { ...DIRECT, expectedSha: "abc" }, fakeClock());
  assert.deepEqual(got, {
    status: "fail",
    failing: ["build"],
    logPath: path.join(runDir, "ci-0.log"),
  });
  assert.equal(fs.readFileSync(got.logPath, "utf8"), "===== build (l) =====");
});
