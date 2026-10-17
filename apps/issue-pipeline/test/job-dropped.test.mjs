// @ts-check
// A stage job keeps what it drops (dropped-changes-saved, #369): its exit
// records the patches that saved its checkouts' uncommitted changes in
// job.json's droppedPatches, names them on stderr, and, when the run
// stopped, posts one keyed comment that says where they are, naming no
// local path.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  logOf,
  READY_SPEC,
  repliesAt,
  runJob,
  SPEC_SESSION,
  setUp,
  startJob,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";

const { droppedNotice, stoppedRun } = await import("../src/job/teardown.ts");

/** @import { Place } from "./job-test-kit.mjs" */
/** @import { RunEnd } from "../src/job/teardown.ts" */
/** @import { SweepSummary } from "../src/workflow/stages/types.ts" */

const ISSUE = 7;
const STOPPED_BY_SIGTERM = 143;
const REPO_PATCH = /^dropped\/(?<key>implement-\d{8}T\d{9}Z)-repo\.patch$/u;
const DOCS_PATCH = /^dropped\/triage-\d{8}T\d{9}Z-docs\.patch$/u;
const DROPPED_KEY = /^dropped-/u;
const NOTICE_FAILED = /job: dropped notice: /u;
const LOCAL_PATH = /(?:^|[\s`(])(?:\/|~)/u;
const NOTHING_APPLIES = /Nothing applies/u;
const RUN_DIRECTORY = /run directory/u;
const KEY = "implement-1";
const PATCHES = [`dropped/${KEY}-repo.patch`, `dropped/${KEY}-docs.patch`];
// The structured output of a triage agent that finds the issue ready.
const READY_TRIAGE = {
  decision: "ready",
  reason: "Small.",
  questions: [],
  plan: "Change src/a.ts and test it.",
};
// The fake ops answers the notice's post; ROUTINE_OPS answers it too.
const POSTING = { post: { ok: true } };
const POST_FAILS = { post: { ok: false, error: "gh failed" } };

/** @param {Place} place @returns {boolean} whether a launch spent tokens */
function spent(place) {
  const launches = statusOf(place)?.launches ?? [];
  return launches.some((/** @type {any} */ launch) => launch.usage.input > 0);
}

/** @param {Place} place @returns {any[]} the comments the dropped notices post */
function notices(place) {
  return logOf(place, "ops.log")
    .filter(({ op }) => op === "post")
    .flatMap(({ comments }) => comments)
    .filter(({ key }) => DROPPED_KEY.test(key));
}

/** @param {string} outcome @param {number} [issue] @returns {RunEnd} */
function sweepEnd(outcome, issue = ISSUE) {
  /** @type {SweepSummary} */
  const summary = {
    sweep: "s1",
    lane: "l",
    repo: "o/r",
    waiting: 0,
    abandoned: [],
    items: [{ issue, pr: null, stage: "implement", outcome, reason: null }],
    parentsClosed: 0,
    cleanup: { worktrees: [], error: null },
  };
  return { kind: "finished", summary };
}

/** @param {"stopped" | "saved"} kind @returns {RunEnd} */
function roleEnd(kind) {
  /** @type {{ kind: "stopped", code: string } | { kind: "saved", stage: string }} */
  let end = { kind: "saved", stage: "spec" };
  if (kind === "stopped") {
    end = { kind: "stopped", code: "error" };
  }
  return { kind: "finished", summary: { issue: ISSUE, stage: "spec", end } };
}

test("a finished writer whose issue stopped saves its patch, which job.json names, and posts the notice", () => {
  const place = setUp(
    { ...repliesAt("implement"), ...POSTING },
    { ...SPEC_SESSION, untracked: "repo/left.txt" },
  );
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).items[0].outcome, "stopped");
  const { droppedPatches, lostChanges } = statusOf(place);
  assert.deepEqual(lostChanges, ["repo/left.txt"]);
  assert.equal(droppedPatches.length, 1);
  assert.match(droppedPatches[0], REPO_PATCH);
  assert.ok(fs.existsSync(path.join(place.runDir, droppedPatches[0])));
  assert.equal(notices(place).length, 1);
});

test("a notice whose post fails is reported on stderr and the job still exits 0", () => {
  const place = setUp(
    { ...repliesAt("implement"), ...POST_FAILS },
    { ...SPEC_SESSION, untracked: "repo/left.txt" },
  );
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, NOTICE_FAILED);
  assert.equal(r.stdout.trim().split("\n").length, 1);
});

test("a finished run whose issue didn't stop saves its patch and posts nothing", () => {
  const place = setUp(
    { ...repliesAt("triage"), ...POSTING },
    {
      untracked: "docs/Page.md",
      events: [messageEnd(USAGE), outputEnd(READY_TRIAGE)],
    },
    {},
    { wiki: true },
  );
  const r = runJob(place, ["--stage", "triage"]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(JSON.parse(r.stdout).end.kind, "stopped");
  const { droppedPatches } = statusOf(place);
  assert.equal(droppedPatches.length, 1);
  assert.match(droppedPatches[0], DOCS_PATCH);
  assert.ok(fs.existsSync(path.join(place.runDir, droppedPatches[0])));
  assert.deepEqual(notices(place), []);
});

test("a writer stopped by SIGTERM names its patch on stderr and posts one keyed notice with no local path", async () => {
  const place = setUp(
    { ...repliesAt("implement"), ...POSTING },
    {
      untracked: "repo/left.txt",
      events: [messageEnd(USAGE), "wait", outputEnd(READY_SPEC)],
    },
  );
  const job = startJob(place, ["--stage", "implement"]);
  await waitFor("the session's spending in job.json", () => spent(place));
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.equal(end.stdout, "");
  const [patch = ""] = statusOf(place).droppedPatches;
  const { key = "" } = REPO_PATCH.exec(patch)?.groups ?? {};
  assert.notEqual(key, "");
  assert.ok(end.stderr.includes(path.join(place.runDir, patch)), end.stderr);
  const last = logOf(place, "ops.log").at(-1);
  assert.equal(last.op, "post");
  assert.equal(last.comments.length, 1);
  const [comment] = last.comments;
  assert.equal(comment.number, ISSUE);
  assert.equal(comment.key, `dropped-${key}`);
  assert.ok(comment.body.includes(key));
  assert.match(comment.body, RUN_DIRECTORY);
  assert.equal(comment.body.includes(place.root), false);
});

test("a reader job with no changes saves no patch and makes no dropped folder", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
  const r = runJob(place, ["--stage", "spec"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(statusOf(place).droppedPatches, []);
  assert.equal(fs.existsSync(path.join(place.runDir, "dropped")), false);
});

test("the dropped notice names the job, each checkout and the run directory, and no local path", () => {
  const body = droppedNotice(KEY, PATCHES);
  assert.ok(body.includes(KEY));
  assert.ok(body.includes("`repo/`"));
  assert.ok(body.includes("`docs/`"));
  assert.match(body, RUN_DIRECTORY);
  assert.match(body, NOTHING_APPLIES);
  assert.doesNotMatch(body, LOCAL_PATH);
});

test("a run counts as stopped for a signal, a stopped sweep item or a stopped role line, and for nothing else", () => {
  assert.equal(stoppedRun(ISSUE, { kind: "stopped", signal: "SIGTERM" }), true);
  assert.equal(stoppedRun(ISSUE, { kind: "stopped", signal: "SIGINT" }), true);
  assert.equal(stoppedRun(ISSUE, sweepEnd("stopped")), true);
  assert.equal(stoppedRun(ISSUE, roleEnd("stopped")), true);
  assert.equal(stoppedRun(ISSUE, sweepEnd("advanced")), false);
  assert.equal(stoppedRun(ISSUE, sweepEnd("stopped", ISSUE + 1)), false);
  assert.equal(stoppedRun(ISSUE, roleEnd("saved")), false);
  assert.equal(stoppedRun(ISSUE, null), false);
});
