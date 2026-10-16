// @ts-check
// The ci-status op: the PR's required checks, read through a fake gh. Through
// the CLI it checks each reply and the failed-log file; imported with a fake
// clock it checks the 3-minute no-checks grace and the wait's deadline, with
// no real time passing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { installFakeGh } from "./fake-gh.mjs";
import { setEnv } from "./ops-run-test-kit.mjs";
import { askRaw } from "./verify-test-kit.mjs";

/** @import { Config } from "../src/config.ts" */
/** @import { Clock } from "../src/ops/ci-status.ts" */
/** @import { GhReply } from "./fake-gh.mjs" */

const root = fs.mkdtempSync("/tmp/issue-pipeline-ci-status-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", root);
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
/** @type {Config} */
const cfg = {
  repo: "o/r",
  account: "a",
  allowedUsers: ["a"],
  baseBranch: "integration",
  claimWaitSeconds: [0, 0],
  commands: { test: "true" },
  contextLimits: { soft: 150_000, hard: 175_000 },
  leaseHours: 3,
  maxContinuations: 1,
  practices: [],
  requireCi: true,
  ciWaitMinutes: 30,
  slug: "o__r",
};
const ISSUE = 3;
const PR = 9;
const DIRECT = { number: ISSUE, pr: PR };
const runDir = path.join(root, "runs", "o__r", `issue-${ISSUE}`);
const HEAD = { when: "pr view", stdout: JSON.stringify({ headRefOid: "abc" }) };
const RUN_LINK = "https://github.com/o/r/actions/runs/555/job/7";
const MS_PER_MINUTE = 60_000;
const GRACE_MINUTES = 3;
const GRACE_MS = GRACE_MINUTES * MS_PER_MINUTE;

const LOG_NAME = /^ci-\d+\.log$/u;
// The part of a failing reply that names its log file.
const LOGGED = z.looseObject({ logPath: z.string() });

/** @param {object[]} checks @returns {GhReply} */
function checksReply(checks) {
  return { when: "pr checks", stdout: JSON.stringify(checks) };
}

/** @param {object} extra @returns {object} */
function request(extra) {
  return { op: "ci-status", config, number: ISSUE, pr: PR, ...extra };
}

/** @param {object} extra @returns {object} */
function reply(extra) {
  return { ok: true, op: "ci-status", posted: 0, ...extra };
}

/** @param {object} body @returns {unknown} */
function askCi(body) {
  return JSON.parse(askRaw(root, request(body)));
}

test("a head that moved stops the wait", () => {
  fakeGh.reply([
    { when: "pr view", stdout: JSON.stringify({ headRefOid: "def" }) },
  ]);
  assert.deepEqual(
    askCi({ expectedSha: "abc" }),
    reply({ status: "head-changed", headSha: "def" }),
  );
});

test("required checks that all pass pass, by name", () => {
  const checks = [
    { name: "build", state: "SUCCESS", bucket: "pass", link: "l1" },
    { name: "e2e", state: "SKIPPED", bucket: "skipping", link: "l2" },
  ];
  fakeGh.reply([HEAD, checksReply(checks)]);
  assert.deepEqual(
    askCi({ expectedSha: "abc" }),
    reply({ status: "pass", checks: ["build", "e2e"] }),
  );
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
  const got = LOGGED.parse(askCi({}));
  assert.deepEqual(
    got,
    reply({
      status: "fail",
      failing: ["build", "deploy"],
      logPath: got.logPath,
    }),
  );
  assert.equal(path.dirname(got.logPath), runDir);
  assert.match(path.basename(got.logPath), LOG_NAME);
  const log = fs.readFileSync(got.logPath, "utf8");
  for (const fact of ["build", RUN_LINK, "boom", "deploy"]) {
    assert.ok(log.includes(fact), fact);
  }
});

// A clock where each sleep moves the time on by its length.
/** @returns {Clock} */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: (/** @type {number} */ ms) => {
      time += ms;
    },
  };
}

// Enough replies for the polls of a 3-minute grace, and of a 1-minute wait.
const GRACE_POLLS = 8;
const DEADLINE_POLLS = 4;
const WAIT_MINUTES = 2;

/** @type {[string, string][]} */
const NO_CHECKS_OUTPUTS = [
  ["", "nothing"],
  ["not json", "not JSON"],
  ['{"name":"x"}', "not an array"],
  ["[]", "no checks"],
];
for (const [output, label] of NO_CHECKS_OUTPUTS) {
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
    assert.ok(clock.now() >= GRACE_MS, "waits out the grace");
    assert.ok(clock.now() < GRACE_MS + MS_PER_MINUTE, "and no longer");
  });
}

test("no checks for 3 minutes pass when CI isn't required", () => {
  fakeGh.reply([]);
  const clock = fakeClock();
  assert.deepEqual(ciStatus({ ...cfg, requireCi: false }, DIRECT, clock), {
    status: "pass",
    checks: [],
  });
  assert.ok(clock.now() >= GRACE_MS, "waits out the grace");
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
  // The wait gives up once its 1-minute deadline has passed.
  assert.ok(clock.now() >= MS_PER_MINUTE, "waits to the deadline");
  assert.ok(clock.now() < MS_PER_MINUTE + MS_PER_MINUTE, "and no longer");
});

test("the config's wait applies when the request names none", () => {
  fakeGh.reply([]);
  const clock = fakeClock();
  const got = ciStatus({ ...cfg, ciWaitMinutes: WAIT_MINUTES }, DIRECT, clock);
  // With no checks the 3-minute grace outlasts a 2-minute wait.
  assert.deepEqual(got, { status: "pending" });
  assert.ok(clock.now() >= WAIT_MINUTES * MS_PER_MINUTE, "waits 2 minutes");
  assert.ok(clock.now() < GRACE_MS, "not the grace's 3");
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
  assert.ok(fs.readFileSync(got.logPath, "utf8").includes("build"));
});
