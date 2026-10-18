// @ts-check
// The spec writer resumes from what it committed (#335, `every-role-resumes`),
// on the runner with its real checks and bare origins: a run killed after its
// session committed a test starts again from that commit, keeping its
// attempts and start heads, and a handoff starts a continuation that resumes
// from the commits and the handoff, until maxContinuations runs out and the
// issue stops as too large, counting the continuations a killed run took.
// The state it saves at implement leaves the implementer its own
// continuations (#414).
// Every run is made before the tests, because the fake gh's writes are
// global.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { BRANCH, specWriter } from "./spec-writer-git-test-kit.mjs";
import { INTERFACE, replyOf } from "./spec-writer-role-test-kit.mjs";

// The implementor's kit imports src/, so it is imported after the spec
// writer's git kit has set the pipeline root to a temp folder; a static
// import would load src/ first, and the run's mirrors would land in the
// real pipeline root, shared with every other run.
const {
  HANDOFF: IMPL_HANDOFF,
  located,
  stepFrom,
} = await import("./implementor-role-test-kit.mjs");

/** @typedef {Awaited<ReturnType<typeof specWriter>>} Ran */

const FIRST_TEST = "test/a.test.sh";
const FIRST_TEXT = "# the first session's test\nexit 1\n";
const SECOND_TEST = "test/b.test.sh";
const STUB = "src/a.ts";
// The first session commits one test; the second, the rest and the stub.
const CODES = [
  { [FIRST_TEST]: FIRST_TEXT },
  { [SECOND_TEST]: "exit 1\n", [STUB]: "export function parseQuota() {}\n" },
];
const READY = replyOf({
  interfaces: [{ ...INTERFACE, where: STUB }],
});
const HANDOFF = { status: "handoff", summary: "Half done: a.test.sh." };
const CONTINUES =
  /^A previous session ran out of room\. Read its handoff first: /u;
// The first session, the continuation killed after it committed, and the
// restart's session.
const SESSIONS_AROUND_A_KILL = 3;
const RESUMES = "don't rewrite the tests already committed";
/** @param {number} max @returns {string} the stop reason with `max` continuations */
function outOfRoomReason(max) {
  return `the spec writer ran out of room in its session and its ${max} continuation(s) (maxContinuations); the issue needs splitting`;
}

/** @param {Ran} ran @returns {number} the sessions the run ran */
function sessions(ran) {
  return ran.calls.filter(({ kind }) => kind === "session").length;
}

/** @param {string} bare @param {string} file @returns {string} `file` on the issue's branch in `bare` */
function onBranch(bare, file) {
  return execFileSync("git", ["--git-dir", bare, "show", `${BRANCH}:${file}`], {
    encoding: "utf8",
  });
}

/** @param {Ran} ran @returns {number[]} the indexes of the run's session calls */
function sessionCalls(ran) {
  /** @type {number[]} */
  const found = [];
  for (const [index, { kind }] of ran.calls.entries()) {
    if (kind === "session") {
      found.push(index);
    }
  }
  return found;
}

// An uninterrupted run shows which effect call is the first session.
const probe = await specWriter({ replies: [READY], codes: CODES });
const sessionCall = probe.calls.findIndex(({ kind }) => kind === "session");
const killed = await specWriter({
  replies: [READY],
  codes: CODES,
  existing: true,
  kill: { k: sessionCall + 1, when: "after" },
});
const handedOff = await specWriter({
  replies: [HANDOFF, READY],
  codes: CODES,
});
// Killed after the continuation's session: the restart keeps the
// continuation taken, so its session's handoff finds none left (the
// context's maxContinuations is 1).
const [, continuationCall = -1] = sessionCalls(handedOff);
const killedContinuing = await specWriter({
  replies: [HANDOFF],
  codes: CODES,
  kill: { k: continuationCall + 1, when: "after" },
});
const outOfRoom = await specWriter({
  replies: [HANDOFF],
  codes: CODES,
  sweep: { maxContinuations: 0 },
});

test("a run killed after its session committed a test keeps that test and adds the rest", () => {
  const { end, repo, tasks } = killed;
  assert.deepEqual(end, { kind: "saved", stage: "implement" });
  assert.equal(onBranch(repo.origin, FIRST_TEST), FIRST_TEXT);
  assert.equal(onBranch(repo.origin, SECOND_TEST), "exit 1\n");
  assert.ok(onBranch(repo.origin, STUB).includes("parseQuota"));
  assert.equal(tasks.length, 2);
  const [first = "", second = ""] = tasks;
  assert.ok(!first.includes(RESUMES), first);
  assert.ok(second.includes(`\`${FIRST_TEST}\``), second);
  assert.ok(second.includes(RESUMES), second);
});

test("a restart keeps the attempts and the start heads the first run saved", () => {
  const { saved, repo } = killed;
  assert.deepEqual(saved.checkpoints, {
    startSha: repo.heads.code,
    startWikiSha: repo.heads.wiki,
    attempts: 2,
    continuations: 0,
  });
});

test("a handoff starts a continuation that resumes from the commits and the handoff, using no attempt", () => {
  const { end, saved, tasks, repo } = handedOff;
  assert.deepEqual(end, { kind: "saved", stage: "implement" });
  assert.equal(sessions(handedOff), 2);
  const { attempts } = saved.checkpoints ?? {};
  assert.equal(attempts, 1);
  const [first = "", second = ""] = tasks;
  assert.ok(!CONTINUES.test(first), first);
  assert.ok(CONTINUES.test(second), second);
  assert.ok(second.includes(repo.handoffFile), second);
  assert.ok(second.includes(`\`${FIRST_TEST}\``), second);
  assert.equal(onBranch(repo.origin, FIRST_TEST), FIRST_TEXT);
});

// The implementor keeps its count in the same checkpoint (#414).
test("the spec writer's continuation leaves the implementer its own: its state saved at implement starts the implementer with none taken", () => {
  const { saved } = handedOff;
  assert.equal(saved.stage, "implement");
  const { continuations } = saved.checkpoints ?? {};
  assert.equal(continuations, 0);
  const { data } = located(saved);
  assert.equal(data.continuations, 0);
  const step = stepFrom("implementer-reply", "handoff", null, {
    ...data,
    reply: IMPL_HANDOFF,
  });
  assert.equal(step.state.at, "implementer");
  assert.equal(step.state.data.continuations, 1);
});

test("a handoff past maxContinuations stops the issue as too large", () => {
  const { end, saved, labels } = outOfRoom;
  const { stopReason } = saved;
  assert.equal(sessions(outOfRoom), 1);
  assert.deepEqual(end, { kind: "stopped", code: "too-large" });
  assert.equal(stopReason, outOfRoomReason(0));
  assert.deepEqual(labels, ["agent:stopped-too-large"]);
});

test("a restart after a continuation keeps its count, so the next handoff stops the issue as too large", () => {
  const { end, saved, labels } = killedContinuing;
  const { stopReason } = saved;
  const { continuations } = saved.checkpoints ?? {};
  assert.equal(sessions(killedContinuing), SESSIONS_AROUND_A_KILL);
  assert.equal(continuations, 1);
  assert.deepEqual(end, { kind: "stopped", code: "too-large" });
  assert.equal(stopReason, outOfRoomReason(1));
  assert.deepEqual(labels, ["agent:stopped-too-large"]);
});
