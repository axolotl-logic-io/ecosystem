// @ts-check
// A stage job at `implement` runs the implementor role (#414): mock model
// (the fake RPC pi), local git origins and fake ops. `done` with a code
// change pushes once and saves at review with the PR untouched; the setup
// command runs in the job's checkout and is logged, and a failed one doesn't
// stop the implementer; no code
// change and `blocked` stop as not doable; a handoff runs one continuation,
// and one past maxContinuations stops as too large; an issue with no PR
// saved ends at open-pr; a state saved by today's implement stage resumes
// with its count; a branch with a code change since specTestsSha goes
// straight to the push; a stale wiki-only issue goes to review.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  claimWith,
  draftRemovedOnOrigin,
  implementReplies,
  PUSHED,
} from "./implementor-job-test-kit.mjs";
import {
  BLOCKED,
  BLOCKED_REASON,
  CHANGED_NOTHING,
  DONE,
  HANDOFF,
} from "./implementor-role-test-kit.mjs";
import { BASE, branchOnOrigin, refOf } from "./job-git-test-kit.mjs";
import {
  logOf,
  piCommands,
  piStarts,
  runJob,
  setUp,
  USAGE,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const RUN = ["--stage", "implement"];
const PR_OPS = ["open-pr", "start-pr", "close-pr"];
const CONTINUES = /A previous session ran out of room/u;
// One continuation, as the config's default.
const ONE_CONTINUATION = { maxContinuations: 1 };
// The PR the claimed issue has.
const PR = 42;
// The setup command's log in the issue's run folder.
const SETUP_LOG = "setup-at-implement.log";
// The command's exit status, as the log records it.
const EXIT_0 = /--- exit 0 ---/u;
const EXIT_2 = /--- exit 2 ---/u;
// What `pwd; git rev-parse --abbrev-ref HEAD` prints in the job's code
// checkout: its folder, `repo/` in the job's folder, on the issue's branch.
const JOB_CHECKOUT_OUT =
  /--- stdout ---\n\S*\/jobs\/issue-7-implement\S*\/repo\nagent\/issue-7\n/u;

/** @param {unknown} reply @returns {object[]} a session that spends USAGE and replies `reply` */
function session(reply) {
  return [messageEnd(USAGE), outputEnd(reply)];
}

/** @param {{ stdout: string }} r @returns {unknown} the job's end, from its summary line */
function endOf(r) {
  const [line = "{}"] = r.stdout.trim().split("\n").slice(-1);
  return JSON.parse(line).end;
}

/** @param {Place} place @param {string} op @returns {any[]} the requests of `op` */
function requestsOf(place, op) {
  return logOf(place, "ops.log").filter((request) => request.op === op);
}

/** @param {Place} place @returns {any} the last state the job saved */
function lastSaved(place) {
  return requestsOf(place, "save-state").at(-1)?.state;
}

/** @param {Place} place @returns {any} the stop op's request, if one ran */
function stopOf(place) {
  return requestsOf(place, "stop").at(-1);
}

/** @param {Place} place @returns {string[]} the PR ops the job sent */
function prOpsOf(place) {
  return logOf(place, "ops.log")
    .map(({ op }) => String(op))
    .filter((op) => PR_OPS.includes(op));
}

test("done with a code change pushes once and saves at review, the PR untouched", () => {
  const place = setUp(implementReplies(), { events: session(DONE) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "review" });
  assert.equal(piStarts(place).length, 1);
  assert.equal(requestsOf(place, "push").length, 1);
  assert.deepEqual(prOpsOf(place), []);
  const saved = lastSaved(place);
  assert.equal(saved.stage, "review");
  assert.equal(saved.headSha, PUSHED);
  assert.equal(saved.implemented, true);
  assert.deepEqual(saved.flows, { code: true, wiki: false });
  assert.equal(saved.pr, PR);
});

/** @param {string} setup @returns {{ commands: Record<string, string> }} the config's commands with `setup` */
function withSetup(setup) {
  return { commands: { test: "true", setup } };
}

/** @param {Place} place @returns {string} the setup command's log at implement */
function setupLog(place) {
  return fs.readFileSync(path.join(place.runDir, SETUP_LOG), "utf8");
}

test("the setup command runs in the job's checkout at implement, and is logged", () => {
  const setup = withSetup("pwd; git rev-parse --abbrev-ref HEAD");
  const place = setUp(implementReplies(), { events: session(DONE) }, setup);
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "review" });
  assert.equal(piStarts(place).length, 1);
  const log = setupLog(place);
  assert.match(log, JOB_CHECKOUT_OUT, log);
  assert.match(log, EXIT_0, log);
});

test("a failed setup command is logged, and the implementer still runs", () => {
  const place = setUp(
    implementReplies(),
    { events: session(DONE) },
    withSetup("echo broken; exit 2"),
  );
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "review" });
  assert.equal(piStarts(place).length, 1);
  assert.equal(lastSaved(place).stage, "review");
  assert.match(setupLog(place), EXIT_2);
});

test("done with no code change stops as not doable", () => {
  const replies = implementReplies({}, false);
  const place = setUp(replies, { events: session(DONE) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "stopped", code: "not-doable" });
  const stop = stopOf(place);
  assert.equal(stop.code, "not-doable");
  assert.equal(stop.reason, CHANGED_NOTHING);
  assert.deepEqual(prOpsOf(place), []);
});

test("blocked stops as not doable with its summary, and pushes nothing", () => {
  const place = setUp(implementReplies(), { events: session(BLOCKED) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "stopped", code: "not-doable" });
  const stop = stopOf(place);
  assert.equal(stop.reason, BLOCKED_REASON);
  assert.equal(stop.detail, BLOCKED.summary);
  assert.deepEqual(requestsOf(place, "push"), []);
});

test("a handoff runs one continuation from the handoff, then saves at review", () => {
  const script = { launches: [session(HANDOFF), session(DONE)] };
  const place = setUp(implementReplies(), script, ONE_CONTINUATION);
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "review" });
  assert.equal(piStarts(place).length, 2);
  const prompts = piCommands(place).filter(({ type }) => type === "prompt");
  const [first, second] = prompts.map(({ message }) => String(message));
  assert.doesNotMatch(first ?? "", CONTINUES);
  assert.match(second ?? "", CONTINUES);
  assert.equal(lastSaved(place).checkpoints.continuations, 1);
});

test("a handoff past maxContinuations stops with agent:stopped-too-large", () => {
  const script = { launches: [session(HANDOFF), session(HANDOFF)] };
  const place = setUp(implementReplies(), script, ONE_CONTINUATION);
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "stopped", code: "too-large" });
  assert.equal(piStarts(place).length, 2);
  assert.equal(stopOf(place).code, "too-large");
  assert.deepEqual(requestsOf(place, "push"), []);
});

test("an issue with no PR saved ends at open-pr, sending no PR op", () => {
  const replies = implementReplies({ pr: null });
  const place = setUp(replies, { events: session(DONE) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "open-pr" });
  assert.deepEqual(prOpsOf(place), []);
  assert.equal(lastSaved(place).implemented, true);
});

test("a state saved by today's implement stage resumes with its continuation count", () => {
  for (const continuations of [1, { implement: 1 }]) {
    const fields = { continuations, phase: "decide" };
    const script = { events: session(HANDOFF) };
    const place = setUp(implementReplies(fields), script, ONE_CONTINUATION);
    const r = runJob(place, RUN);
    const label = JSON.stringify(continuations);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(endOf(r), { kind: "stopped", code: "too-large" }, label);
    assert.equal(piStarts(place).length, 1, label);
  }
});

test("a branch with a code change since specTestsSha goes straight to the push", () => {
  const place = setUp(implementReplies(), { events: session(DONE) });
  branchOnOrigin(place.origin);
  claimWith(place, {
    specTestsSha: refOf(place.origin, `refs/heads/${BASE}`),
  });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "review" });
  assert.deepEqual(piStarts(place), []);
  assert.equal(requestsOf(place, "push").length, 1);
});

test("a branch at specTestsSha, or past it only by the spec draft's removal, runs the implementer", () => {
  const atSpec = setUp(implementReplies(), { events: session(DONE) });
  claimWith(atSpec, { specTestsSha: branchOnOrigin(atSpec.origin) });
  const draft = setUp(implementReplies(), { events: session(DONE) });
  claimWith(draft, { specTestsSha: draftRemovedOnOrigin(draft.origin) });
  for (const place of [atSpec, draft]) {
    const r = runJob(place, RUN);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(endOf(r), { kind: "saved", stage: "review" });
    assert.equal(piStarts(place).length, 1);
  }
});

test("a stale implement of a wiki-only issue saves at review with no session and no push", () => {
  const fields = { wikiOnly: true, noTestsReason: "The wiki is the change." };
  const place = setUp(implementReplies(fields), { events: session(DONE) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "review" });
  assert.deepEqual(piStarts(place), []);
  assert.deepEqual(requestsOf(place, "push"), []);
});
