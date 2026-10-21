// @ts-check
// The usage log's job side (#302), now a role stage's bookkeeping
// (src/job/run-usage.ts), which role-run.ts feeds: one session entry for each
// session that ends, however it ends, with each role's attempts counted, and
// one job entry with the stages the job went through, its outcome, its
// seconds and its sessions' summed tokens. It replaces the removed role
// runner's toy-world tests (runner-test-kit.mjs): handoff and context-stop
// endings left with session budgets, and the issue's rated tokens with the
// token budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";
import { pinnedOf } from "../prompt-test-kit.mjs";
import { LAUNCH } from "../usage-fixtures.mjs";

const { endedOf, runUsage } = await import("../../src/job/run-usage.ts");

/** @import { FinishedSession } from "../../src/job/run-usage.ts" */

const STARTED = new Date("2026-10-16T12:00:00.000Z");
const ENDED_AT = new Date("2026-10-16T12:00:30.000Z");
const JOB_SECONDS = 30;
const TASK_CHARS = 16;

/**
 * An implementor session that finished at STARTED, with `over` on top.
 * @param {Partial<FinishedSession>} [over]
 * @returns {FinishedSession}
 */
function finished(over = {}) {
  return {
    at: STARTED,
    key: "i7-implementor-1",
    stage: "implement",
    phase: null,
    role: "implementor",
    agent: "issue-pipeline-implementor",
    model: "mock",
    taskChars: TASK_CHARS,
    prompt: pinnedOf("developer.md").provenance,
    ok: true,
    reply: { outcome: "done" },
    launch: LAUNCH,
    signalled: false,
    ...over,
  };
}

/** @type {readonly [string, Partial<FinishedSession>, string][]} */
const ENDINGS = [
  ["a reply", {}, "reply"],
  ["a failed session", { ok: false }, "error"],
  ["a signal during the session", { signalled: true }, "aborted"],
  [
    "a signal during a failed session",
    { ok: false, signalled: true },
    "aborted",
  ],
];

for (const [how, over, ended] of ENDINGS) {
  test(`${how} gives one session entry, ended ${ended}`, () => {
    const usage = runUsage("implement", STARTED);
    const entry = usage.session(finished(over));
    assert.equal(endedOf(finished(over)), ended);
    assert.deepEqual(
      [entry.kind, entry.ended, entry.stage, entry.state, entry.name],
      ["session", ended, "implement", "implement", "implementor"],
    );
    assert.deepEqual(
      [entry.at, entry.key, entry.attempt, entry.taskChars],
      [STARTED.toISOString(), "i7-implementor-1", 1, TASK_CHARS],
    );
    assert.deepEqual(entry.launch, LAUNCH);
  });
}

test("a reviewer session's record names its phase as its state, and its stage still as its stage", () => {
  const usage = runUsage("merge", STARTED);
  /** @type {readonly ("integration" | "security-review")[]} */
  const phases = ["integration", "security-review"];
  const states = phases.map((phase) => {
    const entry = usage.session(
      finished({ stage: "merge", phase, role: "reviewer" }),
    );
    return [entry.stage, entry.state, entry.name];
  });
  assert.deepEqual(states, [
    ["merge", "integration", "reviewer"],
    ["merge", "security-review", "reviewer"],
  ]);
});

test("a session's reply is kept only when it replied", () => {
  const usage = runUsage("implement", STARTED);
  assert.deepEqual(usage.session(finished()).reply, { outcome: "done" });
  const failed = finished({ ok: false, reply: { outcome: "done" } });
  assert.equal(usage.session(failed).reply, null);
});

test("each role's sessions count up their own attempts", () => {
  const usage = runUsage("implement", STARTED);
  const author = { role: /** @type {const} */ ("author"), stage: "author" };
  const attempts = [
    usage.session(finished()),
    usage.session(finished(author)),
    usage.session(finished()),
  ].map((entry) => [entry.name, entry.attempt]);
  assert.deepEqual(attempts, [
    ["implementor", 1],
    ["author", 1],
    ["implementor", 2],
  ]);
});

test("the job entry lists its stages, outcome, seconds and its sessions' summed tokens", () => {
  const usage = runUsage("implement", STARTED);
  usage.session(finished());
  usage.session(finished());
  usage.moved("review");
  const job = usage.job("saved", ENDED_AT);
  assert.deepEqual(
    [job.kind, job.at, job.stages, job.outcome, job.seconds],
    [
      "job",
      ENDED_AT.toISOString(),
      ["implement", "review"],
      "saved",
      JOB_SECONDS,
    ],
  );
  assert.deepEqual(job.tokens, {
    input: 2 * LAUNCH.tokens.input,
    output: 2 * LAUNCH.tokens.output,
    cacheRead: 2 * LAUNCH.tokens.cacheRead,
    cacheWrite: 2 * LAUNCH.tokens.cacheWrite,
    cacheWrite1h: 2 * LAUNCH.tokens.cacheWrite1h,
    cost: 2 * LAUNCH.tokens.cost,
  });
});

test("a job interrupted before any session spent nothing and stayed at its stage", () => {
  const job = runUsage("merge", STARTED).job("interrupted", ENDED_AT);
  assert.deepEqual([job.stages, job.outcome], [["merge"], "interrupted"]);
  assert.deepEqual(job.tokens, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cost: 0,
  });
});
