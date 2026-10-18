// @ts-check
// The orchestrator's backoff after a model provider's rate limit
// (`rate-limit-defers`): once a job ends with its issue deferred on a rate
// limit (job.json's outcome `rateLimited`), every start and every restart is
// held, logged as `held` with reason `rate-limited`, for
// rateLimitBackoffMinutes (5 by default). Each rate-limited end after a
// backoff has passed doubles the next, up to 30 minutes; a job that finishes
// without one after a backoff starts the next from the configured minutes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  cfg,
  configWith,
  deadPid,
  MINUTE_MS,
  NOW,
  runFile,
  SWEEP_STAGE,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");

/** @import { Config } from "../src/config.ts" */
/** @import { StatusFile } from "../src/job/status.ts" */
/** @import { OpenIssue } from "./orchestrator-world-test-kit.mjs" */

/** @type {StatusFile["outcome"]} */
const RATE_LIMITED = { kind: "finished", rateLimited: true };
/** @type {StatusFile["outcome"]} */
const FINISHED = { kind: "finished", rateLimited: false };
const DEFAULT_BACKOFF = 5;
const MAX_BACKOFF = 30;
const SHORT_BACKOFF = 2;
// Each test's issues: the one whose job hit the rate limit, and one waiting
// at triage, whose start the backoff holds.
const ONCE = { limited: 90, waiting: 91 };
const REPEATED = { limited: 92, waiting: 93 };
const OVERLAPPING = { limited: 94, waiting: 95 };
const CONFIGURED = { limited: 96, waiting: 97 };
const RESTART = { limited: 98, dead: 99 };
// The backoffs of five rate limits in a row, each after the last passed.
const DOUBLED = [
  DEFAULT_BACKOFF,
  DEFAULT_BACKOFF * 2,
  DEFAULT_BACKOFF * 2 * 2,
  MAX_BACKOFF,
  MAX_BACKOFF,
];

// Issue `limited`'s `stage` job ended `minutes` after NOW with `outcome`.
/** @param {number} limited @param {number} minutes @param {StatusFile["outcome"]} [outcome] @param {string} [stage] @returns {void} */
function endedAt(limited, minutes, outcome = RATE_LIMITED, stage = "review") {
  const at = new Date(NOW.getTime() + minutes * MINUTE_MS).toISOString();
  writeJob({ issue: limited, stage, pid: deadPid(), outcome, endedAt: at });
}

/** @param {{ limited: number, waiting: number }} pair @returns {OpenIssue[]} */
function queueOf({ limited, waiting }) {
  return [{ number: limited, state: { stage: "review" } }, { number: waiting }];
}

// What ticks over the pair's issues do the minute before `backoff` minutes
// after `from`, and that minute: the jobs each spawns, and the reason the
// first logged for the waiting issue.
/**
 * @param {{ limited: number, waiting: number }} pair
 * @param {number} from
 * @param {number} backoff
 * @param {Config} [config]
 * @returns {{ before: number, reason: string | undefined, after: number }}
 */
function aroundBackoff(pair, from, backoff, config = cfg) {
  const issues = queueOf(pair);
  const before = tickOver(issues, from + backoff - 1, { config }).spawned;
  const reason = loggedFor(pair.waiting).at(-1)?.reason;
  const after = tickOver(issues, from + backoff, { config }).spawned;
  return { before: before.length, reason, after: after.length };
}

// Every start held as rate-limited, then both issues' jobs started.
const HELD_THEN_STARTED = { before: 0, reason: "rate-limited", after: 2 };

/** @returns {void} */
function noBackoff() {
  fs.rmSync(runFile("backoff.json"), { force: true });
}

test("after a job ends rate-limited every start is held as rate-limited for 5 minutes", () => {
  noBackoff();
  endedAt(ONCE.limited, 0);
  assert.deepEqual(aroundBackoff(ONCE, 0, DEFAULT_BACKOFF), HELD_THEN_STARTED);
});

test("each rate limit after a backoff passed doubles the next, up to 30 minutes, and a clean finish starts again from 5", () => {
  noBackoff();
  let minute = 0;
  for (const backoff of DOUBLED) {
    endedAt(REPEATED.limited, minute);
    const around = aroundBackoff(REPEATED, minute, backoff);
    assert.deepEqual(around, HELD_THEN_STARTED, `a ${backoff}-minute backoff`);
    minute += backoff + 1;
  }
  endedAt(REPEATED.limited, minute, FINISHED);
  assert.equal(tickOver(queueOf(REPEATED), minute).spawned.length, 2);
  endedAt(REPEATED.limited, minute + 1);
  assert.deepEqual(
    aroundBackoff(REPEATED, minute + 1, DEFAULT_BACKOFF),
    HELD_THEN_STARTED,
  );
});

test("a job already running when the backoff began, ending rate-limited inside it, doesn't lengthen it", () => {
  noBackoff();
  endedAt(OVERLAPPING.limited, 0);
  assert.deepEqual(tickOver(queueOf(OVERLAPPING), 0).spawned, []);
  endedAt(OVERLAPPING.limited, 2);
  assert.deepEqual(
    aroundBackoff(OVERLAPPING, 0, DEFAULT_BACKOFF),
    HELD_THEN_STARTED,
  );
});

test("rateLimitBackoffMinutes sets the backoff", () => {
  noBackoff();
  const short = loadConfig(configWith({ rateLimitBackoffMinutes: 2 }));
  endedAt(CONFIGURED.limited, 0);
  assert.deepEqual(
    aroundBackoff(CONFIGURED, 0, SHORT_BACKOFF, short),
    HELD_THEN_STARTED,
  );
});

test("a dead job's restart is held as rate-limited during a backoff", () => {
  noBackoff();
  endedAt(RESTART.limited, 0, RATE_LIMITED, "spec");
  writeJob({ issue: RESTART.dead, stage: SWEEP_STAGE, pid: deadPid() });
  const issues = [
    { number: RESTART.limited, state: { stage: "spec" } },
    { number: RESTART.dead, state: { stage: SWEEP_STAGE } },
  ];
  assert.deepEqual(tickOver(issues, 0).spawned, []);
  assert.deepEqual(loggedFor(RESTART.dead), [
    {
      issue: RESTART.dead,
      stage: SWEEP_STAGE,
      action: "held",
      reason: "rate-limited",
    },
  ]);
  const { spawned } = tickOver(issues, DEFAULT_BACKOFF);
  assert.ok(spawned.some((argv) => argv.includes("--resume")));
});
