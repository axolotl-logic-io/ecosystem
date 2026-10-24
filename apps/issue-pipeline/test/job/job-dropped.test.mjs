// @ts-check
// A stage job keeps what it drops (dropped-changes-saved, #369): its exit
// records the patches that saved its checkouts' uncommitted changes in
// job.json's droppedPatches, names them on stderr, and, when the run
// stopped, posts one keyed comment that says where they are, naming no
// local path. The implementor is the writer and the author the reader.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { waitFor } = await import("../bounded-test-kit.mjs");
const { messageEnd, outputEnd } = await import("../fake-rpc-pi.mjs");
const {
  AUTHOR_SESSION,
  IMPLEMENTED,
  implementReplies,
  READER_STAGE,
  repliesAt,
  USAGE,
} = await import("../job-fixtures.mjs");
const { logOf, runJob, setUp, startJob, statusOf } = await import(
  "./job-test-kit.mjs"
);

/** @import { Place } from "./job-test-kit.mjs" */

const ISSUE = 7;
const STOPPED_BY_SIGTERM = 143;
const REPO_PATCH = /^dropped\/(?<key>implement-\d{8}T\d{9}Z)-repo\.patch$/u;
const AUTHOR_PATCH = /^dropped\/author-\d{8}T\d{9}Z-repo\.patch$/u;
const DROPPED_KEY = /^dropped-/u;
const NOTICE_FAILED = /job: dropped notice: /u;
const LOCAL_PATH = /(?:^|[\s`(])(?:\/|~)/u;
const RUN_DIRECTORY = /run directory/u;
// The fake ops answers the notice's post. The author's Gherkin post needs
// ROUTINE_OPS's reply, with its comment id.
const POSTING = { post: { ok: true } };
const POST_FAILS = { post: { ok: false, error: "gh failed" } };
// An implementor session that spends USAGE and can't do the issue, which
// stops it.
const CANNOT = { outcome: "cannot", reason: "The issue contradicts itself." };
const BLOCKED_SESSION = { events: [messageEnd(USAGE), outputEnd(CANNOT)] };

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

test("a finished writer whose issue stopped saves its patch, which job.json names, and posts the notice", () => {
  const place = setUp(
    { ...implementReplies(), ...POSTING },
    { ...BLOCKED_SESSION, untracked: "repo/left.txt" },
  );
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).end, "stop");
  const { droppedPatches, lostChanges } = statusOf(place);
  assert.deepEqual(lostChanges, ["repo/left.txt"]);
  assert.equal(droppedPatches.length, 1);
  assert.match(droppedPatches[0], REPO_PATCH);
  assert.ok(fs.existsSync(path.join(place.runDir, droppedPatches[0])));
  assert.equal(notices(place).length, 1);
});

test("a notice whose post fails is reported on stderr and the job still exits 0", () => {
  const place = setUp(
    { ...implementReplies(), ...POST_FAILS },
    { ...BLOCKED_SESSION, untracked: "repo/left.txt" },
  );
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, NOTICE_FAILED);
  assert.equal(r.stdout.trim().split("\n").length, 1);
});

test("a finished run whose issue didn't stop saves its patch and posts nothing", () => {
  const place = setUp(repliesAt(READER_STAGE), {
    ...AUTHOR_SESSION,
    untracked: "repo/docs/Page.md",
  });
  const r = runJob(place, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).end, "next");
  const { droppedPatches, lostChanges } = statusOf(place);
  assert.deepEqual(lostChanges, ["repo/docs/Page.md"]);
  assert.equal(
    logOf(place, "ops.log").some(
      ({ op }) => op === "exit-push" || op === "push",
    ),
    false,
  );
  assert.equal(droppedPatches.length, 1);
  assert.match(droppedPatches[0], AUTHOR_PATCH);
  assert.ok(fs.existsSync(path.join(place.runDir, droppedPatches[0])));
  assert.deepEqual(notices(place), []);
  // The author's one post is its Gherkin.
  const posts = logOf(place, "ops.log").filter(({ op }) => op === "post");
  assert.equal(posts.length, 1);
});

test("a writer stopped by SIGTERM names its patch on stderr and posts one keyed notice with no local path", async () => {
  const place = setUp(
    { ...implementReplies(), ...POSTING },
    {
      untracked: "repo/left.txt",
      events: [messageEnd(USAGE), "wait", outputEnd(IMPLEMENTED)],
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
  assert.ok(comment.body.includes("`repo/`"));
  assert.equal(comment.body.includes(place.root), false);
  assert.doesNotMatch(comment.body, LOCAL_PATH);
});
