// @ts-check
// One orchestrator tick (#234): the jobs it spawns and with what arguments
// (rule 10), the line it logs per decision (rule 11), each start's with the
// spawned job's pid and the job id it passed, the start records that
// keep a spawned job live until it writes job.json, and the rate limit fed
// from the ledger (rule 9).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { jobIdOf, withoutJobId } from "./orchestrator-job-id-kit.mjs";
import {
  CONFIG,
  cfg,
  configWith,
  leaseOf,
  NOW,
  openWith,
  root,
  runFile,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { tick } = await import("../src/orchestrator/tick.ts");

/** @import { OpenIssue } from "./orchestrator-world-test-kit.mjs" */

const ISSUE = { merging: 40, accepting: 41, fresh: 42, stopped: 43 };
const RATED = { spent: 50, waiting: 51 };
const STACK = { prereq: 60, dependent: 61 };
const PR = { merging: 1, accepting: 2 };
const TOKENS_PER_HOUR = 1000;
// Past the 2M an hour the orchestrator once held starts at by default.
const PAST_OLD_HOURLY_LIMIT = 3_000_000;
const LOG_LINE = z.strictObject({
  at: z.string(),
  issue: z.number(),
  stage: z.string(),
  action: z.enum(["started", "held"]),
  reason: z.string(),
  pid: z.number().optional(),
  job: z.uuid().optional(),
});
const LEDGER_STARTS = z.object({
  started: z.array(
    z.object({
      issue: z.number(),
      stage: z.string(),
      pid: z.number(),
      at: z.string(),
    }),
  ),
});

/** @type {OpenIssue[]} */
const QUEUE = [
  {
    number: ISSUE.merging,
    labels: ["agent:working"],
    state: { stage: "merge", pr: PR.merging, lease: leaseOf("orchestrator") },
    reads: 2,
  },
  { number: ISSUE.accepting, state: { stage: "accept", pr: PR.accepting } },
  { number: ISSUE.fresh },
  {
    number: ISSUE.stopped,
    // A stop the watchdog's rules end in, so it raises no escalation (#235).
    labels: ["agent:stopped-job"],
    state: { stage: "fix" },
  },
];

// The watchdog's steer and SIGTERM, which no job in these tests is due, and
// the escalation agent, which no config here sets (#282).
const UNWATCHED = {
  runAgent: () => {
    throw new Error("unexpected escalation agent run");
  },
  steer: () => {
    throw new Error("unexpected steer");
  },
  terminate: () => {
    throw new Error("unexpected SIGTERM");
  },
};

/**
 * A spawn that records each call, less its job id, and answers with `pid`;
 * `jobIds` holds each call's job id.
 * @param {number} pid
 * @returns {{ spawned: { argv: readonly string[], log: string }[], jobIds: string[], spawn: (argv: readonly string[], log: string) => number }}
 */
function recordingSpawn(pid) {
  /** @type {{ argv: readonly string[], log: string }[]} */
  const spawned = [];
  /** @type {string[]} */
  const jobIds = [];
  return {
    spawned,
    jobIds,
    spawn: (argv, log) => {
      spawned.push({ argv: withoutJobId(argv), log });
      jobIds.push(jobIdOf(argv));
      return pid;
    },
  };
}

/** @returns {z.infer<typeof LOG_LINE>[]} */
function logLines() {
  const text = fs.readFileSync(runFile("orchestrator.log"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LOG_LINE.parse(JSON.parse(line)));
}

/** @param {number} issue @param {string} stage @param {string} [mergeQueue] @returns {string[]} */
function argvOf(issue, stage, mergeQueue) {
  const argv = [
    "--config",
    CONFIG,
    "--issue",
    String(issue),
    "--stage",
    stage,
    "--lane",
    "orchestrator",
  ];
  if (mergeQueue === undefined) {
    return argv;
  }
  return [...argv, "--merge-queue", mergeQueue];
}

/** @param {number} issue @returns {string} */
function jobLogOf(issue) {
  return path.join(root, "runs", cfg.slug, `issue-${issue}`, "job.log");
}

test("a tick spawns each start in the orchestrator lane with its own job id, logs every decision with the job's pid and id, and records the starts", () => {
  openWith(QUEUE);
  const { spawned, jobIds, spawn } = recordingSpawn(process.pid);
  const { decisions } = tick(cfg, {
    configPath: CONFIG,
    now: () => NOW,
    spawn,
    ...UNWATCHED,
  });
  const queue = `${ISSUE.merging},${ISSUE.accepting}`;
  assert.deepEqual(spawned, [
    {
      argv: argvOf(ISSUE.merging, "merge", queue),
      log: jobLogOf(ISSUE.merging),
    },
    { argv: argvOf(ISSUE.accepting, "accept"), log: jobLogOf(ISSUE.accepting) },
    { argv: argvOf(ISSUE.fresh, "triage"), log: jobLogOf(ISSUE.fresh) },
  ]);
  assert.equal(new Set(jobIds).size, jobIds.length);
  const at = NOW.toISOString();
  const { pid } = process;
  const expected = [
    { issue: ISSUE.merging, stage: "merge", reason: "merge-first" },
    { issue: ISSUE.accepting, stage: "accept", reason: "free" },
    { issue: ISSUE.fresh, stage: "triage", reason: "free" },
  ].map((start, n) => ({
    at,
    ...start,
    action: "started",
    pid,
    job: jobIds[n],
  }));
  assert.deepEqual(logLines(), expected);
  assert.equal(decisions.length, expected.length);
  const { started } = LEDGER_STARTS.parse(
    JSON.parse(fs.readFileSync(runFile("orchestrator.json"), "utf8")),
  );
  assert.deepEqual(
    started,
    expected.map(({ issue, stage }) => ({
      issue,
      stage,
      pid: process.pid,
      at,
    })),
  );
});

test("the next tick starts nothing for a spawned job that still runs but has written no job.json", () => {
  openWith(QUEUE);
  const { spawned, spawn } = recordingSpawn(process.pid);
  const before = logLines().length;
  assert.deepEqual(
    tick(cfg, { configPath: CONFIG, now: () => NOW, spawn, ...UNWATCHED })
      .decisions,
    [],
  );
  assert.deepEqual(spawned, []);
  assert.equal(logLines().length, before);
});

test("once the jobs' tokens in the last hour reach tokensPerHour every start is held for the rate limit", () => {
  const rated = loadConfig(configWith({ tokensPerHour: TOKENS_PER_HOUR }));
  writeJob({
    issue: RATED.spent,
    stage: "review",
    pid: process.pid,
    ended: true,
    tokens: TOKENS_PER_HOUR,
  });
  openWith([
    { number: RATED.spent, state: { stage: "accept" } },
    { number: RATED.waiting },
  ]);
  const { spawned, spawn } = recordingSpawn(process.pid);
  const { decisions } = tick(rated, {
    configPath: CONFIG,
    now: () => NOW,
    spawn,
    ...UNWATCHED,
  });
  assert.deepEqual(spawned, []);
  assert.deepEqual(
    decisions.map(({ issue, action, reason }) => ({ issue, action, reason })),
    [
      { issue: RATED.spent, action: "held", reason: "rate-limit" },
      { issue: RATED.waiting, action: "held", reason: "rate-limit" },
    ],
  );
});

test("with tokensPerHour unset, the default, no start is held for the rate limit however many tokens the jobs used", () => {
  const unrated = loadConfig(configWith({}));
  const { tokensPerHour } = unrated;
  assert.equal(tokensPerHour, null);
  writeJob({
    issue: RATED.spent,
    stage: "review",
    pid: process.pid,
    ended: true,
    tokens: PAST_OLD_HOURLY_LIMIT,
  });
  openWith([
    { number: RATED.spent, state: { stage: "accept" } },
    { number: RATED.waiting },
  ]);
  const { spawned, spawn } = recordingSpawn(process.pid);
  const { decisions } = tick(unrated, {
    configPath: CONFIG,
    now: () => NOW,
    spawn,
    ...UNWATCHED,
  });
  assert.deepEqual(
    decisions.map(({ issue, action }) => ({ issue, action })),
    [
      { issue: RATED.spent, action: "started" },
      { issue: RATED.waiting, action: "started" },
    ],
  );
  assert.equal(spawned.length, 2);
});

test("a waiting issue whose prerequisite is at checks starts stacked on it", () => {
  openWith([
    { number: STACK.prereq, state: { stage: "checks", headSha: "abc" } },
    {
      number: STACK.dependent,
      body: `<!-- agent-pipeline:after ${STACK.prereq} -->`,
    },
  ]);
  const { spawned, spawn } = recordingSpawn(process.pid);
  tick(cfg, { configPath: CONFIG, now: () => NOW, spawn, ...UNWATCHED });
  const stackOn = ["--stack-on", String(STACK.prereq)];
  assert.deepEqual(
    spawned.find(({ log }) => log === jobLogOf(STACK.dependent)),
    {
      argv: [...argvOf(STACK.dependent, "triage"), ...stackOn],
      log: jobLogOf(STACK.dependent),
    },
  );
  assert.deepEqual(
    logLines()
      .filter(({ issue }) => issue === STACK.dependent)
      .map(({ stage, action, reason }) => ({ stage, action, reason })),
    [{ stage: "triage", action: "started", reason: "free" }],
  );
});
