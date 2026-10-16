// A session other than a writer's that the stage job stops at
// contextLimits.hard is run once more, fresh, with the read-in-parts line
// added to its task (#272). A retry that overflows too fails with an error
// naming the overflow; a writer still hands off after one session; and a
// context-stopped session is never resumed. Each async test has a timeout so
// a session the job never stops fails the test instead of hanging at the
// fake pi's "wait".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resumePoints } from "../src/job/status.ts";
import { outputEnd, TURN_OUTPUT, turns } from "./fake-rpc-pi.mjs";
import {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  READY_SPEC,
  repliesAt,
  runJob,
  setScript,
  setUp,
  startJob,
  statusOf,
  USAGE,
  waitFor,
} from "./job-test-kit.mjs";
import { ISSUE, sweepReply } from "./workflow-stages-fixtures.mjs";

const LIMITS = { contextLimits: { soft: 1000, hard: 2000 } };
// Turn contexts below soft and past hard, and what one turn of each spends:
// its context and its output tokens.
const LOW = 600;
const PAST_HARD = 2100;
const LOW_TOTAL = LOW + TURN_OUTPUT;
const PAST_HARD_TOTAL = PAST_HARD + TURN_OUTPUT;
// A hang guard, not a timing dependency: without the context watch, the job
// never stops a session waiting at the fake pi's "wait".
const HANG_GUARD = { timeout: 60_000 };
// The line the wiki (Issue-Pipeline, contextLimits) promises the retry's
// prompt adds to the task, word for word.
const READ_IN_PARTS =
  "Your earlier session on this task passed the context limit and was stopped: read the diff in parts, one file or line range at a time, and keep your context small.";
const SPEC_KEY = "spec-1";
const RETRY_KEY = `${SPEC_KEY}.retry`;
const INTERRUPTED = /interrupted/u;

/** @param {import("./job-test-kit.mjs").Place} place @returns {any[]} */
function promptsOf(place) {
  return piCommands(place).filter(({ type }) => type === "prompt");
}

/** @param {import("./job-test-kit.mjs").Place} place @returns {any[]} */
function sessionsOf(place) {
  return statusOf(place).launches.filter(
    (/** @type {{ kind: string }} */ { kind }) => kind === "session",
  );
}

/** @param {any} status a job.json, or null @returns {any} its retry, or null */
function retryOf(status) {
  return (
    status?.launches.find((/** @type {{ key: string }} */ { key }) =>
      key.endsWith(".retry"),
    ) ?? null
  );
}

/** @param {import("./job-test-kit.mjs").Place} place @param {string} op */
function opOf(place, op) {
  return logOf(place, "ops.log").find((request) => request.op === op);
}

test(
  "a spec writer that overflows once and then succeeds yields its result",
  HANG_GUARD,
  async () => {
    const launches = [
      [...turns([PAST_HARD]), "wait"],
      [...turns([LOW]), outputEnd(READY_SPEC)],
    ];
    const place = setUp(repliesAt("spec"), { launches }, LIMITS);
    const end = await startJob(place, ["--stage", "spec"]).end;
    assert.equal(end.status, 0, end.stderr);
    const [first, second] = promptsOf(place);
    assert.equal(promptsOf(place).length, 2);
    assert.ok(second.message.startsWith(first.message), second.message);
    assert.ok(second.message.includes(READ_IN_PARTS), second.message);
    assert.equal(opOf(place, "stop"), undefined);
    const { state } = opOf(place, "release");
    assert.equal(state.reportedTokens, PAST_HARD_TOTAL + LOW_TOTAL);
    const sessions = sessionsOf(place);
    assert.equal(sessions.length, 2);
    const [overflowed, retry] = sessions;
    assert.equal(retry.key, `${overflowed.key}.retry`);
    assert.deepEqual(overflowed.contextStop, {
      context: PAST_HARD,
      result: "error",
    });
    assert.equal(retry.contextStop, null);
    assert.equal(overflowed.outcome, "ok");
    assert.equal(retry.outcome, "ok");
  },
);

test(
  "a spec writer that overflows on every launch stops the issue with error",
  HANG_GUARD,
  async () => {
    const events = [...turns([PAST_HARD]), "wait"];
    const place = setUp(repliesAt("spec"), { events }, LIMITS);
    const end = await startJob(place, ["--stage", "spec"]).end;
    assert.equal(end.status, 0, end.stderr);
    const stop = opOf(place, "stop");
    assert.equal(stop.code, null);
    for (const fact of ["hard limit", String(PAST_HARD), "twice"]) {
      assert.ok(stop.detail.includes(fact), stop.detail);
    }
    for (const session of sessionsOf(place)) {
      assert.equal(session.outcome, "failed");
    }
  },
);

test(
  "a writer past hard hands off after exactly one session",
  HANG_GUARD,
  async () => {
    const replies = {
      ...repliesAt("implement"),
      sweep: sweepReply({ items: [ISSUE], config: { maxContinuations: 0 } }),
    };
    const events = [...turns([PAST_HARD]), "wait"];
    const place = setUp(replies, { events }, LIMITS);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    assert.equal(piStarts(place).length, 1);
    const sessions = sessionsOf(place);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].contextStop.result, "handoff");
    for (const prompt of promptsOf(place)) {
      assert.ok(!prompt.message.includes(READ_IN_PARTS), prompt.message);
    }
  },
);

/**
 * A run folder whose job.json holds an interrupted session launch for each
 * of `launches`, each with its session file on disk.
 * @param {{ key: string, contextStop: object | null }[]} launches
 * @returns {string}
 */
function interruptedRun(launches) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-run-"));
  process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
  const startedAt = new Date().toISOString();
  const records = launches.map(({ key, contextStop }) => {
    const session = path.join(runDir, `${key}.jsonl`);
    fs.writeFileSync(session, "{}\n");
    return {
      key,
      kind: "session",
      pid: null,
      session,
      startedAt,
      lastEventAt: null,
      toolFailures: 0,
      usage: USAGE,
      contextStop,
      resumed: false,
      outcome: null,
    };
  });
  const status = {
    version: 1,
    pid: 1,
    issue: 7,
    stage: "spec",
    lane: null,
    startedAt,
    socket: path.join(runDir, "job.sock"),
    outcome: null,
    launches: records,
  };
  fs.writeFileSync(path.join(runDir, "job.json"), JSON.stringify(status));
  return runDir;
}

test("--resume never resumes a context-stopped session, but resumes its interrupted retry", () => {
  const retryKey = RETRY_KEY;
  const runDir = interruptedRun([
    { key: SPEC_KEY, contextStop: { context: PAST_HARD, result: "error" } },
    { key: retryKey, contextStop: null },
  ]);
  const pointOf = resumePoints(runDir);
  assert.equal(pointOf(SPEC_KEY), null);
  assert.deepEqual(pointOf(retryKey), {
    session: path.join(runDir, `${retryKey}.jsonl`),
    usage: USAGE,
  });
});

test(
  "--resume after a job stopped during a retry resumes the retry's session",
  HANG_GUARD,
  async () => {
    const launches = [
      [...turns([PAST_HARD]), "wait"],
      [...turns([LOW]), "wait"],
    ];
    const place = setUp(repliesAt("spec"), { launches }, LIMITS);
    const job = startJob(place, ["--stage", "spec"]);
    // job.json is missing until the job starts, so read it null-safe.
    await waitFor(() => retryOf(statusOf(place))?.usage.input > 0);
    job.child.kill("SIGTERM");
    await job.end;
    setScript(place, { events: [...turns([LOW]), outputEnd(READY_SPEC)] });
    const r = runJob(place, ["--stage", "spec", "--resume"]);
    assert.equal(r.status, 0, r.stderr);
    const [, retryStart, resumeStart, ...more] = piStarts(place);
    assert.deepEqual(more, []);
    const retrySession = flagValue(retryStart.argv, "--session");
    assert.equal(flagValue(resumeStart.argv, "--session"), retrySession);
    assert.match(promptsOf(place).at(-1).message, INTERRUPTED);
    const [resumed] = sessionsOf(place);
    assert.ok(resumed.key.endsWith(".retry"), resumed.key);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.outcome, "ok");
    assert.equal(opOf(place, "stop"), undefined);
  },
);
