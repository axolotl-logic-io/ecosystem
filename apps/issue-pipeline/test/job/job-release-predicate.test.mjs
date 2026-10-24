// @ts-check
// The verified release predicate (#151), through the real job against the
// private fake GitHub (fake-job-coordination.mjs), which keeps only the
// coordination records the job's real transport wrote. A job releases
// issue-execution ownership only after a confirmed checkpoint, preserved
// work and no unresolved stop or write; otherwise it holds, and the next
// job can't acquire. No hold repeats a write to get a clearer answer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  alive,
  endsWithTest,
  killGroup,
  pidIn,
  waitFor,
} from "../bounded-test-kit.mjs";
import { messageEnd } from "../fake-rpc-pi.mjs";
import {
  AFTER_READER_STAGE,
  AUTHOR_SESSION,
  IMPLEMENTOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
  USAGE,
} from "../job-fixtures.mjs";
import { coordinationRecords } from "./fake-job-coordination.mjs";
import { logOf, piStarts, runJob, setUp, startJob } from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const LANE = ["--lane", "L"];
const HELD = /job: execution held: /u;
const UNRESOLVED_SAVE =
  /execution held: unresolved checkpoint write: save-state/u;
const NOT_PRESERVED = /execution held: teardown didn't preserve/u;
const RETAINED = /recovery incomplete; checkout retained/u;
const UNCERTAIN_RELEASE = /uncertain release/u;
const UNRECONCILED = /uncertain coordination write retained/u;
const REFUSED = "another invocation owns the issue";
const STOPPED_BY_SIGTERM = 143;
const HANG_PID = "hang.pid";
const NETWORK = "error connecting to api.github.com: HTTP 502";

/** @param {Place} place @returns {string[]} the coordination records' kinds */
function kinds(place) {
  return coordinationRecords(place.root).map(({ kind }) => kind);
}

/** @param {Place} place @param {string} op @returns {any[]} the job's requests of `op` */
function opsOf(place, op) {
  return logOf(place, "ops.log").filter((request) => request.op === op);
}

/** @param {Place} place @returns {number} the release comments POSTed */
function releasePosts(place) {
  const file = path.join(place.root, "coordination.log");
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(
      (line) =>
        line.includes("POST") && line.includes('\\"kind\\":\\"release\\"'),
    ).length;
}

/** @param {Place} place @returns {{ ops: number, pi: number }} the ops run and pi starts so far */
function countOf(place) {
  return { ops: logOf(place, "ops.log").length, pi: piStarts(place).length };
}

/**
 * Runs a second job after a hold: its exit, its line and whether it ran an
 * op or started pi, which a held issue's next job must not.
 * @param {Place} place @param {readonly string[]} args
 */
function nextJob(place, args) {
  const before = countOf(place);
  const r = runJob(place, [...args, ...LANE]);
  const line = JSON.parse(r.stdout || "null");
  const after = countOf(place);
  return {
    r,
    line,
    ranNothing: after.ops === before.ops && after.pi === before.pi,
  };
}

/** @param {ReturnType<typeof nextJob>} next @returns {object} what a held issue's next job shows */
function heldView(next) {
  return {
    status: next.r.status,
    end: next.line?.end,
    ranNothing: next.ranNothing,
  };
}

const HELD_VIEW = { status: 0, end: "unclaimed", ranNothing: true };
// The records of one job's acquisition and release.
const ONE_RUN = 3;

test("a stage mismatch starts no writer, keeps the exact checkpoint and releases; the retry on the same lane is a new invocation", () => {
  const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const r = runJob(place, ["--stage", AFTER_READER_STAGE, ...LANE]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    issue: 7,
    stage: AFTER_READER_STAGE,
    end: "unclaimed",
    reason: `the issue is at ${READER_STAGE}, not ${AFTER_READER_STAGE}`,
  });
  assert.deepEqual(piStarts(place), []);
  const [claim] = opsOf(place, "claim");
  assert.ok(claim);
  const [kept] = opsOf(place, "release");
  assert.deepEqual(
    kept.state,
    /** @type {any} */ (repliesAt(READER_STAGE).claim).state,
  );
  assert.deepEqual(kinds(place), ["request", "confirm", "release"]);
  const retry = runJob(place, ["--stage", READER_STAGE, ...LANE]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.notEqual(JSON.parse(retry.stdout).end, "unclaimed");
  assert.equal(piStarts(place).length, 1);
  const [first, , , second] = coordinationRecords(place.root);
  assert.equal(second.kind, "request");
  assert.notEqual(second.identity.instance, first.identity.instance);
  assert.deepEqual(
    { ...second.identity, instance: null },
    { ...first.identity, instance: null },
  );
  assert.deepEqual(kinds(place).slice(ONE_RUN), [
    "request",
    "confirm",
    "release",
  ]);
});

test("an uncertain checkpoint save holds ownership, though the run deferred and released its state", () => {
  const replies = {
    ...implementReplies(),
    "save-state": { ok: false, error: NETWORK },
  };
  const place = setUp(replies, IMPLEMENTOR_SESSION);
  const r = runJob(place, ["--stage", "implement", ...LANE]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).end, "deferred");
  assert.match(r.stderr, UNRESOLVED_SAVE);
  assert.equal(opsOf(place, "save-state").length, 1);
  assert.equal(opsOf(place, "release").length, 1);
  assert.deepEqual(kinds(place), ["request", "confirm"]);
  const next = nextJob(place, ["--stage", "implement"]);
  assert.deepEqual(heldView(next), HELD_VIEW);
  assert.equal(next.line.reason, REFUSED);
  assert.equal(opsOf(place, "save-state").length, 1);
});

test("a release whose response is lost holds when read-back can't prove it, and keeps its journal without posting again", () => {
  const place = setUp(implementReplies(), IMPLEMENTOR_SESSION);
  const fault = path.join(place.root, "coordination-fault.json");
  fs.writeFileSync(fault, JSON.stringify({ release: "unconfirmed" }));
  const r = runJob(place, ["--stage", "implement", ...LANE]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, UNCERTAIN_RELEASE);
  assert.equal(releasePosts(place), 1);
  assert.deepEqual(kinds(place), ["request", "confirm"]);
  const journal = path.join(place.runDir, "coordination-uncertain.json");
  assert.equal(
    JSON.parse(fs.readFileSync(journal, "utf8")).operation,
    "release",
  );
  fs.rmSync(fault);
  const next = nextJob(place, ["--stage", "implement"]);
  assert.deepEqual(heldView(next), HELD_VIEW);
  assert.match(next.line.claimError, UNRECONCILED);
  assert.equal(releasePosts(place), 1);
  assert.ok(fs.existsSync(journal));
});

test("a release whose response is lost but whose read-back proves it counts as released, with one POST", () => {
  const place = setUp(implementReplies(), IMPLEMENTOR_SESSION);
  const fault = path.join(place.root, "coordination-fault.json");
  fs.writeFileSync(fault, JSON.stringify({ release: "lost" }));
  const r = runJob(place, ["--stage", "implement", ...LANE]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(releasePosts(place), 1);
  assert.deepEqual(kinds(place), ["request", "confirm", "release"]);
  assert.equal(
    fs.existsSync(path.join(place.runDir, "coordination-uncertain.json")),
    false,
  );
});

test("failed preservation keeps the checkout and its work and holds ownership", () => {
  const place = setUp(implementReplies(), {
    ...IMPLEMENTOR_SESSION,
    untracked: "repo/kept.txt",
  });
  // A file where the dropped/ folder goes makes saving the patch fail.
  fs.mkdirSync(place.runDir, { recursive: true });
  fs.writeFileSync(path.join(place.runDir, "dropped"), "prior evidence\n");
  const r = runJob(place, ["--stage", "implement", ...LANE]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, RETAINED);
  assert.match(r.stderr, NOT_PRESERVED);
  const jobs = path.join(place.root, "work", "o__r", "jobs");
  const [checkout] = fs.readdirSync(jobs);
  assert.ok(checkout);
  const kept = path.join(jobs, checkout, "repo", "kept.txt");
  assert.equal(fs.readFileSync(kept, "utf8"), "left\n");
  assert.deepEqual(kinds(place), ["request", "confirm"]);
  const next = nextJob(place, ["--stage", "implement"]);
  assert.deepEqual(heldView(next), HELD_VIEW);
  assert.equal(next.line.reason, REFUSED);
  assert.ok(fs.existsSync(kept));
});

test("a signal while the stop op runs leaves its stop unresolved and holds ownership", async () => {
  const replies = { ...implementReplies(), stop: { hang: true } };
  const failed = {
    type: "message_end",
    message: { role: "assistant", errorMessage: "the model gave up" },
  };
  const place = setUp(replies, { events: [messageEnd(USAGE), failed] });
  endsWithTest(() => {
    const sleep = pidIn(place.root, HANG_PID);
    if (sleep !== null && alive(sleep)) {
      killGroup(sleep);
    }
  });
  const job = startJob(place, ["--stage", "implement", ...LANE]);
  await waitFor("the hung stop", () => pidIn(place.root, HANG_PID) !== null);
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.match(end.stderr, HELD);
  assert.equal(opsOf(place, "stop").length, 1);
  const dir = path.join(place.runDir, "stop-recovery");
  const [record] = fs.readdirSync(dir);
  assert.ok(record);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, record), "utf8"));
  assert.equal(saved.result, "reconciliation-required");
  assert.deepEqual(kinds(place), ["request", "confirm"]);
  const next = nextJob(place, ["--stage", "implement"]);
  assert.deepEqual(heldView(next), HELD_VIEW);
  assert.equal(next.line.reason, REFUSED);
  assert.equal(opsOf(place, "stop").length, 1);
});

// The job's own outcome when nothing is uncertain: the ordinary completion
// releases through the same predicate (job-invocation.test.mjs shows its
// records), and a later job acquires.
test("an ordinary completion releases and the next job on the lane acquires", () => {
  const place = setUp(implementReplies(), IMPLEMENTOR_SESSION);
  const r = runJob(place, ["--stage", "implement", ...LANE]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, HELD);
  assert.deepEqual(kinds(place), ["request", "confirm", "release"]);
  const again = runJob(place, ["--stage", "implement", ...LANE]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(kinds(place).slice(ONE_RUN), [
    "request",
    "confirm",
    "release",
  ]);
});
