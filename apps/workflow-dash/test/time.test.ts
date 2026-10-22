import assert from "node:assert/strict";
import { test } from "node:test";
import {
  elapsed,
  limit,
  sessionTime,
  timeBreakdown,
  timeline,
} from "../time.ts";
import { makeRun } from "./model-fixtures.ts";

const elapsedCases = [
  { start: 1000, end: 61_000, seconds: 60 },
  { start: 1000, end: 0, seconds: 0 },
];
const warningCases = [
  { key: "implementor-1", now: 2_880_000, warning: true },
  { key: "reviewer-2", now: 1_439_000, warning: false },
  { key: "author-3", now: 1_440_000, warning: true },
];
const intervals = {
  total: 60_000,
  secondStart: 40_000,
  firstSeconds: 20,
  secondSeconds: 40,
  journalSeconds: 60,
};
const nonBudgetElapsed = 9_999_999;
test("elapsed limits and warning threshold", () => {
  for (const point of elapsedCases) {
    assert.equal(elapsed(point.start, point.end), point.seconds);
  }
  for (const point of warningCases) {
    assert.equal(limit(point.key, 0, point.now).warning, point.warning);
  }
  assert.equal(limit("claim-1", 0, nonBudgetElapsed).limit, 0);
});
test("consecutive launch deltas, job stages and model/tool message deltas", () => {
  const now = Date.now();
  const run = makeRun(
    {
      startedAt: now - intervals.total,
      endedAt: now,
      launches: [
        { key: "verify-1", kind: "ops", startedAt: now - intervals.total },
        {
          key: "reviewer-1",
          kind: "session",
          startedAt: now - intervals.secondStart,
        },
      ],
    },
    {
      records: [
        {
          kind: "job",
          at: now,
          stages: ["review", "merge"],
          seconds: intervals.journalSeconds,
        },
        { kind: "launch", at: now, seconds: 100 },
      ],
    },
  );
  assert.equal(timeline(run, now)[0].seconds, intervals.firstSeconds);
  const breakdown = timeBreakdown([run], now);
  assert.equal(breakdown.launches["ops/verify"], intervals.firstSeconds);
  assert.equal(breakdown.launches["session/reviewer"], intervals.secondSeconds);
  assert.equal(
    breakdown.types["Hardening → Legacy merge"],
    intervals.journalSeconds,
  );
  assert.deepEqual(
    sessionTime([
      { type: "message", message: { role: "user", timestamp: 1000 } },
      { type: "message", message: { role: "assistant", timestamp: 3000 } },
      { type: "message", message: { role: "toolResult", timestamp: 8000 } },
    ]),
    { model: 2, tool: 5 },
  );
});
