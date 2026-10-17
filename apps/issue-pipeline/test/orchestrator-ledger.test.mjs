// @ts-check
// The orchestrator's ledger, runs/<slug>/orchestrator.json (#234): the tokens
// the jobs spent, as increments that survive a job.json being overwritten,
// the hour the rate limit counts, the tokens it counts (not cache reads), and
// the jobs the orchestrator started.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

/** @import { Config } from "../src/config.ts" */
/** @import { StatusFile } from "../src/job/status.ts" */

const root = fs.mkdtempSync("/tmp/issue-pipeline-ledger-");
// Environment variables are named by strings, as src/process.ts takes them.
Object.assign(process.env, Object.fromEntries([["ISSUE_PIPELINE_ROOT", root]]));
const { openLedger } = await import("../src/orchestrator/ledger.ts");
const { rateTokens } = await import("../src/workflow/rate-tokens.ts");

/** @type {Config} */
const cfg = {
  account: "bot",
  allowedUsers: ["alice"],
  baseBranch: "integration",
  claimWaitSeconds: [0, 0],
  commands: { test: "true" },
  contextLimits: { soft: 150_000, hard: 175_000 },
  leaseHours: 3,
  maxContinuations: 1,
  issueTokenBudget: 1_000_000,
  usageFlags: { firstContext: 40_000, toolOutputShare: 0.25 },
  practices: [],
  repo: "o/r",
  slug: "o__r",
};
const START = Date.parse("2026-10-15T10:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const FIRST_TOKENS = 1000;
const MORE_TOKENS = 500;
const PID = 4242;
const CACHE_READS_PER_INPUT = 10;
// The rate tokens of jobWith's usage per input token: input, output and
// cache writes.
const RATE_PER_INPUT = 3;
const ISSUE = 7;

/** @param {number} minutes @returns {Date} */
function at(minutes) {
  return new Date(START + minutes * MINUTE_MS);
}

// A job.json, started `minute` minutes after START, whose one session spent
// `input` tokens, as many output and cache-write ones, and ten times as many
// cache reads, which the rate limit doesn't count.
/** @param {number} input @param {number} [minute] @returns {StatusFile} */
function jobWith(input, minute = 0) {
  return {
    version: 1,
    pid: PID,
    issue: ISSUE,
    stage: "spec",
    lane: "orchestrator",
    startedAt: at(minute).toISOString(),
    socket: "/tmp/s.sock",
    outcome: null,
    launches: [
      {
        key: "i7-spec-1",
        kind: "session",
        pid: PID,
        session: null,
        startedAt: at(minute).toISOString(),
        lastEventAt: null,
        toolFailures: 0,
        lastToolFailure: null,
        usage: {
          input,
          output: input,
          cacheRead: input * CACHE_READS_PER_INPUT,
          cacheWrite: input,
        },
        tokenBudget: null,
        contextTokens: 0,
        peakContext: 0,
        firstContext: null,
        turns: 0,
        contextStop: null,
        resumed: false,
        pushes: [],
        outcome: null,
      },
    ],
  };
}

test("rateTokens counts input, output and cache writes but not cache reads", () => {
  const usage = { input: 100, output: 20, cacheRead: 300_000, cacheWrite: 40 };
  const counted = usage.input + usage.output + usage.cacheWrite;
  assert.equal(rateTokens(usage), counted);
  assert.equal(rateTokens({ ...usage, cacheRead: 0 }), counted);
});

test("each tick adds only what a launch spent since the last, and a reopened ledger remembers it", () => {
  const ledger = openLedger(cfg);
  ledger.record([jobWith(FIRST_TOKENS)], at(0));
  ledger.record([jobWith(FIRST_TOKENS)], at(1));
  assert.equal(ledger.spentLastHour(at(1)), FIRST_TOKENS * RATE_PER_INPUT);
  ledger.save(at(1));
  const reopened = openLedger(cfg);
  reopened.record([jobWith(FIRST_TOKENS + MORE_TOKENS)], at(2));
  assert.equal(
    reopened.spentLastHour(at(2)),
    (FIRST_TOKENS + MORE_TOKENS) * RATE_PER_INPUT,
  );
  // An hour after the first increment only the later one counts.
  assert.equal(
    reopened.spentLastHour(at(HOUR_MINUTES + 1)),
    MORE_TOKENS * RATE_PER_INPUT,
  );
});

test("a new job that overwrites job.json with the same launch key adds its tokens to the last one's", () => {
  fs.rmSync(path.join(root, "runs", cfg.slug, "orchestrator.json"), {
    force: true,
  });
  const ledger = openLedger(cfg);
  ledger.record([jobWith(FIRST_TOKENS)], at(0));
  // The next job for the issue starts later, with a smaller total so far.
  ledger.record([jobWith(MORE_TOKENS, 1)], at(1));
  const both = (FIRST_TOKENS + MORE_TOKENS) * RATE_PER_INPUT;
  assert.equal(ledger.spentLastHour(at(1)), both);
  ledger.save(at(1));
  const reopened = openLedger(cfg);
  reopened.record([jobWith(MORE_TOKENS, 1)], at(2));
  assert.equal(reopened.spentLastHour(at(2)), both);
});

test("started jobs are kept for an hour, the last one per issue", () => {
  const ledger = openLedger(cfg);
  ledger.launched({
    issue: ISSUE,
    stage: "spec",
    pid: PID,
    at: at(0).toISOString(),
  });
  const later = {
    issue: ISSUE,
    stage: "implement",
    pid: PID,
    at: at(1).toISOString(),
  };
  ledger.launched(later);
  ledger.save(at(1));
  assert.deepEqual(openLedger(cfg).started(), [later]);
  const file = path.join(root, "runs", cfg.slug, "orchestrator.json");
  assert.ok(fs.existsSync(file));
  openLedger(cfg).save(at(HOUR_MINUTES + 2));
  assert.deepEqual(openLedger(cfg).started(), []);
});

test("a launch first seen with no event in the last hour counts nothing, as after a lost ledger", () => {
  fs.rmSync(path.join(root, "runs", cfg.slug, "orchestrator.json"), {
    force: true,
  });
  const old = jobWith(FIRST_TOKENS);
  const [launch] = old.launches;
  assert.ok(launch);
  const twoHoursAgo = at(-2 * HOUR_MINUTES).toISOString();
  /** @type {StatusFile} */
  const finished = {
    ...old,
    startedAt: twoHoursAgo,
    outcome: { kind: "finished" },
    endedAt: twoHoursAgo,
    launches: [
      {
        ...launch,
        startedAt: twoHoursAgo,
        lastEventAt: twoHoursAgo,
        outcome: "ok",
      },
    ],
  };
  const ledger = openLedger(cfg);
  ledger.record([finished], at(0));
  assert.equal(ledger.spentLastHour(at(0)), 0);
  ledger.save(at(0));
  // Its total is remembered, so a later tick doesn't count it either.
  const reopened = openLedger(cfg);
  reopened.record([finished], at(1));
  assert.equal(reopened.spentLastHour(at(1)), 0);
});
