// @ts-check
// One orchestrator tick (#234): the jobs it spawns and with what arguments
// (rule 10), the line it logs per decision (rule 11), the start records that
// keep a spawned job live until it writes job.json, and the rate limit fed
// from the ledger (rule 9).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
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
const PR = { merging: 1, accepting: 2 };
const TOKENS_PER_HOUR = 1000;
const LOG_LINE = z.strictObject({
  at: z.string(),
  issue: z.number(),
  stage: z.string(),
  action: z.enum(["started", "held"]),
  reason: z.string(),
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

// The watchdog's steer and SIGTERM, which no job in these tests is due.
const UNWATCHED = {
  steer: () => {
    throw new Error("unexpected steer");
  },
  terminate: () => {
    throw new Error("unexpected SIGTERM");
  },
};

/**
 * A spawn that records each call and answers with `pid`.
 * @param {number} pid
 * @returns {{ spawned: { argv: readonly string[], log: string }[], spawn: (argv: readonly string[], log: string) => number }}
 */
function recordingSpawn(pid) {
  /** @type {{ argv: readonly string[], log: string }[]} */
  const spawned = [];
  return {
    spawned,
    spawn: (argv, log) => {
      spawned.push({ argv, log });
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

test("a tick spawns each start in the orchestrator lane, logs every decision and records the starts", () => {
  openWith(QUEUE);
  const { spawned, spawn } = recordingSpawn(process.pid);
  const decisions = tick(cfg, {
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
  const at = NOW.toISOString();
  const expected = [
    {
      at,
      issue: ISSUE.merging,
      stage: "merge",
      action: "started",
      reason: "merge-first",
    },
    {
      at,
      issue: ISSUE.accepting,
      stage: "accept",
      action: "started",
      reason: "free",
    },
    {
      at,
      issue: ISSUE.fresh,
      stage: "triage",
      action: "started",
      reason: "free",
    },
  ];
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
    tick(cfg, { configPath: CONFIG, now: () => NOW, spawn, ...UNWATCHED }),
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
  const decisions = tick(rated, {
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
