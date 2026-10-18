// @ts-check
// A stage job's own checkout (#250): cloned from a bare mirror of the repo
// into repo/ in the job's folder, which is its sessions' cwd (#338), the
// checkout every ops request names, closed on every exit, after a writer's
// push of its commits. The author is the reader and the implementor the
// writer. Branch stacking is retired: the checkout starts at the issue's own
// branch or the base, and --stack-on is refused (job-resume.test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { alive, waitFor } from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  AUTHOR_SESSION,
  AUTHORED,
  IMPLEMENTED,
  IMPLEMENTOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
  USAGE,
} from "./job-fixtures.mjs";
import {
  BASE,
  branchOnOrigin,
  checkoutOf,
  refOf,
  repoOf,
} from "./job-git-test-kit.mjs";
import {
  logOf,
  piStarts,
  runJob,
  setScript,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.mjs";

const STOPPED_BY_SIGTERM = 143;
const ISSUE = 7;
const PUSH_FAILED = /job: exit push: /u;
const EXIT_STEP_FAILED = /job: exit: /u;
const BRANCH = "refs/heads/agent/issue-7";
const EXIT_PUSH_KEY = /^exit-push-\d+$/u;
// The exit push the fake ops makes for real from the request's checkout.
const PUSHING = { "exit-push": { ok: true, git: true } };
// A session that commits a file, then waits until it is stopped.
const COMMIT_AND_WAIT = {
  commit: "repo/work.txt",
  events: [messageEnd(USAGE), "wait", outputEnd(IMPLEMENTED)],
};

/** @import { Place } from "./job-test-kit.mjs" */

// An implement job's replies, its exit push made for real.
/** @returns {{ claim: object } & Record<string, unknown>} */
function pushingImplementReplies() {
  return { ...implementReplies(), ...PUSHING };
}

/** @param {Place} place @returns {string} the last sha pi committed */
function committed(place) {
  const entries = logOf(place, "pi.log").filter((line) => "committed" in line);
  return entries.at(-1)?.committed ?? "";
}

/** @param {Place} place @returns {any[]} the exit-push requests */
function pushes(place) {
  return logOf(place, "ops.log").filter(({ op }) => op === "exit-push");
}

/** @param {Place} place @returns {boolean} whether a launch spent tokens */
function spent(place) {
  const launches = statusOf(place)?.launches ?? [];
  return launches.some((/** @type {any} */ launch) => launch.usage.input > 0);
}

test("a job clones its checkout from the mirror, runs its session there and removes it on exit", () => {
  const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const r = runJob(place, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  const mirror = path.join(place.root, "work/o__r/mirror.git");
  assert.equal(refOf(mirror, `refs/heads/${BASE}`), refOf(place.origin, BASE));
  const [start] = piStarts(place);
  assert.equal(
    start.cwd,
    checkoutOf(fs.realpathSync(place.root), READER_STAGE),
  );
  assert.equal(start.head, refOf(place.origin, BASE));
  assert.equal(fs.existsSync(checkoutOf(place.root, READER_STAGE)), false);
});

test("the checkout of an issue with a branch on origin starts at its head", () => {
  const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const earlier = branchOnOrigin(place.origin);
  const r = runJob(place, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  const [start] = piStarts(place);
  assert.equal(start.head, earlier);
});

test("a job stopped by SIGTERM exits 143 and removes its checkout", async () => {
  const place = setUp(repliesAt(READER_STAGE), {
    events: [messageEnd(USAGE), "wait", outputEnd(AUTHORED)],
  });
  const job = startJob(place, ["--stage", READER_STAGE]);
  await waitFor("the session's spending in job.json", () => spent(place));
  assert.ok(fs.existsSync(checkoutOf(place.root, READER_STAGE)));
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.equal(fs.existsSync(checkoutOf(place.root, READER_STAGE)), false);
});

test("a writer's commit reaches the issue's branch through the exit-push op before its checkout goes", () => {
  const place = setUp(pushingImplementReplies(), {
    ...IMPLEMENTOR_SESSION,
    commit: "repo/work.txt",
  });
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  const sha = committed(place);
  assert.notEqual(sha, "");
  assert.equal(refOf(place.origin, BRANCH), sha);
  const [push] = pushes(place);
  assert.equal(push.number, ISSUE);
  assert.deepEqual(push.checkout, {
    issue: ISSUE,
    dir: repoOf(place.root, "implement"),
  });
  const launches = statusOf(place).launches.map(
    (/** @type {{ key: string }} */ launch) => launch.key,
  );
  // Each ops launch's key counts the job's ops launches so far; the exit
  // push is the last.
  assert.match(String(launches.at(-1)), EXIT_PUSH_KEY);
  assert.equal(fs.existsSync(checkoutOf(place.root, "implement")), false);
});

test("a writer whose commits are all on the issue's branch already does not push", () => {
  const place = setUp(pushingImplementReplies(), IMPLEMENTOR_SESSION);
  const earlier = branchOnOrigin(place.origin);
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(piStarts(place)[0].head, earlier);
  assert.deepEqual(pushes(place), []);
  const launches = statusOf(place).launches.map(
    (/** @type {{ key: string }} */ launch) => launch.key,
  );
  assert.equal(
    launches.some((/** @type {string} */ key) => EXIT_PUSH_KEY.test(key)),
    false,
  );
  assert.equal(refOf(place.origin, BRANCH), earlier);
});

test("a writer whose origin is gone at exit reports it on stderr, stops on SIGTERM and removes its checkout", async () => {
  const place = setUp(implementReplies(), COMMIT_AND_WAIT);
  const job = startJob(place, ["--stage", "implement"]);
  await waitFor("the session's spending in job.json", () => spent(place));
  fs.renameSync(place.origin, `${place.origin}-gone`);
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.match(end.stderr, EXIT_STEP_FAILED);
  assert.deepEqual(statusOf(place).lostChanges, []);
  assert.equal(fs.existsSync(checkoutOf(place.root, "implement")), false);
});

test("a writer stopped by SIGTERM still saves with no lease, logs the job's usage and pushes its commit before its checkout goes, leaving no pi", async () => {
  const place = setUp(pushingImplementReplies(), COMMIT_AND_WAIT);
  const job = startJob(place, ["--stage", "implement"]);
  await waitFor("the session's spending in job.json", () => spent(place));
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.equal(refOf(place.origin, BRANCH), committed(place));
  const ops = logOf(place, "ops.log");
  // The stop saves the issue, then the job logs its usage; the push is last.
  const last = ["save-state", "usage", "exit-push"];
  assert.deepEqual(
    ops.slice(-last.length).map(({ op }) => op),
    last,
  );
  const [save] = ops.slice(-last.length);
  assert.deepEqual([save.state.stage, save.state.lease], ["implement", null]);
  assert.equal(
    ops.some(({ op }) => op === "release"),
    false,
  );
  const [{ pid }] = piStarts(place);
  assert.equal(alive(pid), false);
  assert.equal(fs.existsSync(checkoutOf(place.root, "implement")), false);
});

test("a writer's uncommitted files are recorded as lostChanges and dropped", () => {
  const place = setUp(implementReplies(), {
    ...IMPLEMENTOR_SESSION,
    untracked: "repo/left.txt",
  });
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(statusOf(place).lostChanges, ["repo/left.txt"]);
  assert.deepEqual(pushes(place), []);
  assert.equal(fs.existsSync(checkoutOf(place.root, "implement")), false);
});

test("a reader's commit is never pushed", () => {
  const place = setUp(
    { ...repliesAt(READER_STAGE), ...PUSHING },
    {
      ...AUTHOR_SESSION,
      commit: "repo/work.txt",
    },
  );
  const r = runJob(place, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(committed(place), "");
  assert.deepEqual(pushes(place), []);
  assert.equal(refOf(place.origin, BRANCH), "");
  assert.deepEqual(statusOf(place).lostChanges, []);
});

test("every ops request the job makes names its checkout", () => {
  const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  runJob(place, ["--stage", READER_STAGE]);
  const ops = logOf(place, "ops.log");
  assert.ok(ops.length > 0);
  const checkout = { issue: ISSUE, dir: repoOf(place.root, READER_STAGE) };
  for (const request of ops) {
    assert.deepEqual(request.checkout, checkout, request.op);
  }
});

test("a failed exit push is reported on stderr and the checkout still goes", () => {
  const failing = { "exit-push": { ok: false, error: "push refused" } };
  const place = setUp(
    { ...implementReplies(), ...failing },
    {
      ...IMPLEMENTOR_SESSION,
      commit: "repo/work.txt",
    },
  );
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, PUSH_FAILED);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.equal(fs.existsSync(checkoutOf(place.root, "implement")), false);
});

test("the job's wiki checkout comes from the wiki mirror, and its unpushed commits wait there", () => {
  const place = setUp(
    implementReplies(),
    { ...IMPLEMENTOR_SESSION, commit: "docs/Page.md" },
    {},
    { wiki: true },
  );
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  const first = committed(place);
  const wikiMirror = path.join(place.root, "work/o__r/wiki-mirror.git");
  assert.equal(refOf(wikiMirror, BRANCH), first);
  assert.equal(refOf(String(place.wikiOrigin), BRANCH), "");
  setScript(place, { ...IMPLEMENTOR_SESSION, commit: "docs/Other.md" });
  const again = runJob(place, ["--stage", "implement"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(refOf(wikiMirror, `${BRANCH}~1`), first);
  assert.equal(refOf(wikiMirror, BRANCH), committed(place));
});
