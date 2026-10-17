// @ts-check
// The usage log's runner side (#302): the role runner appends one session
// entry for each session that ends, however it ends, and one job entry for
// the run, for both the machine and the linear toy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LAUNCH, runToy, world } from "./runner-test-kit.mjs";

/** @import { Outcome, RunEnd } from "../src/job/runner.ts" */
/** @import { UsageEntry } from "../src/job/run-usage.ts" */
/** @import { ToyRole, WorldOptions } from "./runner-test-kit.mjs" */

/** @type {readonly ToyRole[]} */
const ROLES = ["machine", "linear"];
const CLOCK = "2026-10-16T12:00:00.000Z";

/** @param {number} tries @returns {string} the verify result: fail once */
function failOnce(tries) {
  if (tries === 0) {
    return "fail";
  }
  return "pass";
}

/**
 * The toy `role`'s end and usage entries, run once with `options`.
 * @param {ToyRole} role @param {WorldOptions} [options]
 * @returns {Promise<{ end: RunEnd, usages: UsageEntry[] }>}
 */
async function usageRun(role, options = {}) {
  const place = world(options);
  const end = await runToy(role, place, place.effects().effects);
  return { end, usages: place.usages };
}

/** @param {readonly UsageEntry[]} usages */
function sessionsOf(usages) {
  return usages.flatMap((entry) => {
    if (entry.kind === "session") {
      return [entry];
    }
    return [];
  });
}

/** @param {readonly UsageEntry[]} usages */
function jobsOf(usages) {
  return usages.flatMap((entry) => {
    if (entry.kind === "job") {
      return [entry];
    }
    return [];
  });
}

/** @type {readonly [string, WorldOptions, string][]} */
const ENDINGS = [
  ["a reply", {}, "reply"],
  [
    "a handoff reply",
    { session: { ok: true, name: "replied", reply: { status: "handoff" } } },
    "handoff",
  ],
  ["a context stop", { contextStop: true }, "context-stop"],
  ["a failed session", { session: { ok: false, error: "boom" } }, "error"],
  ["SIGTERM during the session", { signalAt: 3 }, "aborted"],
];

for (const [how, options, ended] of ENDINGS) {
  test(`${how} appends one session entry, ended ${ended}`, async () => {
    const { usages } = await usageRun("machine", options);
    const sessions = sessionsOf(usages);
    assert.equal(sessions.length, 1);
    const [session] = sessions;
    assert.equal(session?.ended, ended);
    assert.equal(session?.stage, "implement");
    assert.equal(session?.state, "work");
    assert.equal(session?.attempt, 1);
    assert.equal(session?.at, CLOCK);
    assert.deepEqual(session?.launch.tokens, LAUNCH.tokens);
    assert.deepEqual(
      [session?.launch.first, session?.launch.peak, session?.launch.atFinish],
      [LAUNCH.first, LAUNCH.peak, LAUNCH.atFinish],
    );
    assert.equal(jobsOf(usages).length, 1);
  });
}

test("a session's handoff reply is kept, as its schema's enum lists it", async () => {
  /** @type {Outcome} */
  const handoff = { ok: true, name: "replied", reply: { status: "handoff" } };
  const { usages } = await usageRun("machine", { session: handoff });
  assert.deepEqual(
    sessionsOf(usages).map((session) => session.reply),
    [{ status: "handoff" }],
  );
});

test("a SIGTERM before any session starts appends no session entry", async () => {
  const { end, usages } = await usageRun("machine", { signalAt: 1 });
  assert.equal(end.kind, "interrupted");
  assert.deepEqual(sessionsOf(usages), []);
  assert.deepEqual(
    jobsOf(usages).map((job) => job.outcome),
    ["interrupted"],
  );
});

test("each retried session gives its own attempt", async () => {
  const { usages } = await usageRun("machine", { verify: failOnce });
  assert.deepEqual(
    sessionsOf(usages).map((session) => [session.attempt, session.ended]),
    [
      [1, "reply"],
      [2, "reply"],
    ],
  );
});

test("the machine's job entry lists its stages, outcome and summed tokens", async () => {
  const { end, usages } = await usageRun("machine", { verify: failOnce });
  assert.deepEqual(end, { kind: "saved", stage: "merge" });
  const jobs = jobsOf(usages);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.deepEqual(job?.stages, ["implement", "checks", "merge"]);
  assert.equal(job?.outcome, "saved");
  assert.equal(job?.tokens.input, 2 * LAUNCH.tokens.input);
  assert.equal(job?.tokens.output, 2 * LAUNCH.tokens.output);
  assert.equal(job?.issueTokens, 0);
  assert.equal(usages.at(-1)?.kind, "job");
});

for (const role of ROLES) {
  test(`the ${role} toy appends its sessions, then one job entry`, async () => {
    const { end, usages } = await usageRun(role);
    assert.deepEqual(
      usages.map((entry) => entry.kind),
      ["session", "job"],
    );
    assert.equal(jobsOf(usages)[0]?.outcome, end.kind);
  });
}

test("a failed session's job entry still ends the run as the runner does", async () => {
  const { end, usages } = await usageRun("linear", {
    session: { ok: false, error: "boom" },
  });
  assert.deepEqual(end, { kind: "stopped", code: "error" });
  assert.deepEqual(
    jobsOf(usages).map((job) => [job.outcome, job.stages]),
    [["stopped", ["implement"]]],
  );
});
