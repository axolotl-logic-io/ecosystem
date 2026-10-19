// The stage job end to end, through job-test-kit.mjs: a fake ops.mjs and a
// fake RPC pi log what they were asked, so the tests see the ops requested,
// every pi command line and every command pi read.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { alive } from "./bounded-test-kit.mjs";
import {
  AFTER_READER_STAGE,
  AUTHOR_SESSION,
  READER_STAGE,
  repliesAt,
} from "./job-fixtures.mjs";
import { checkoutOf } from "./job-git-test-kit.mjs";
import {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  runJob,
  sessionOf,
  setUp,
  statusOf,
} from "./job-test-kit.mjs";

const SESSION_KEY = /^author-1\.jsonl$/u;
const SET_ASIDE_SESSION = /^author-1\.[0-9a-z]+\.jsonl$/u;
const AT_REVIEW = "the issue is at review, not author";
const STAGE_LIST = /--stage must be one of: author, implement, review, merge/u;
const STAGE_ARGS = ["--stage", READER_STAGE, "--lane", "L"];
const MODEL_NOT_FOUND = "Model not found: x/y";

test("a stage job claims its issue, runs the stage's role, releases the issue at the next stage and prints one line", () => {
  const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const ops = logOf(place, "ops.log");
  assert.equal(ops[0].op, "claim");
  assert.equal(ops[0].lane, "L");
  const release = ops.find(({ op }) => op === "release");
  assert.equal(release.state.stage, AFTER_READER_STAGE);
  const calls = piStarts(place);
  assert.equal(calls.length, 1);
  const [{ argv, cwd }] = calls;
  assert.equal(cwd, checkoutOf(fs.realpathSync(place.root), READER_STAGE));
  assert.equal(flagValue(argv, "--mode"), "rpc");
  const [probe, prompt, ...others] = piCommands(place);
  assert.deepEqual(probe, { id: "runtime-policy", type: "get_state" });
  assert.equal(prompt.type, "prompt");
  assert.ok(prompt.message.length > 0);
  assert.deepEqual(others, []);
  const session = flagValue(argv, "--session");
  assert.equal(
    path.dirname(session),
    path.join(place.root, "runs/o__r/issue-7/sessions"),
  );
  assert.match(path.basename(session), SESSION_KEY);
  assert.ok(fs.existsSync(flagValue(argv, "--output-schema")));
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    issue: 7,
    stage: READER_STAGE,
    end: "next",
  });
});

test("a second stage job for the same stage starts a fresh pi session and keeps the first aside", () => {
  const place = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  for (const run of [runJob(place, STAGE_ARGS), runJob(place, STAGE_ARGS)]) {
    assert.equal(run.status, 0, run.stderr);
  }
  const calls = piStarts(place);
  assert.equal(calls.length, 2);
  const [first = "", second] = calls.map(({ argv }) =>
    flagValue(argv, "--session"),
  );
  assert.equal(second, first);
  assert.deepEqual(
    calls.map(({ fresh }) => fresh),
    [true, true],
  );
  const aside = fs
    .readdirSync(path.dirname(first))
    .filter((name) => SET_ASIDE_SESSION.test(name));
  assert.equal(aside.length, 1);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(first), aside[0] ?? ""), "utf8"),
    fs.readFileSync(first, "utf8"),
  );
});

test("a stage job for an issue saved at another stage releases it untouched and runs no session", () => {
  const place = setUp(repliesAt("review"), { events: [] });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const ops = logOf(place, "ops.log").map(({ op }) => op);
  assert.ok(ops.includes("release"), ops.join(","));
  assert.ok(!ops.includes("save-state"), ops.join(","));
  assert.deepEqual(logOf(place, "pi.log"), []);
  assert.deepEqual(JSON.parse(r.stdout), {
    issue: 7,
    stage: READER_STAGE,
    end: "unclaimed",
    reason: AT_REVIEW,
  });
});

test("a stage job with an unknown stage fails before any op", () => {
  const place = setUp(repliesAt(READER_STAGE), { events: [] });
  const r = runJob(place, ["--stage", "nope"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, STAGE_LIST);
  assert.equal(r.stdout, "");
  assert.deepEqual(logOf(place, "ops.log"), []);
});

test("a rejected prompt ends pi's session, and its error fails the launch", () => {
  const place = setUp(repliesAt(READER_STAGE), {
    rejectPrompt: MODEL_NOT_FOUND,
  });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    piCommands(place).map(({ type }) => type),
    ["get_state", "prompt"],
  );
  // The fake pi exits only once its stdin closes.
  const starts = piStarts(place);
  assert.deepEqual(
    starts.map(({ pid }) => alive(pid)),
    [false],
  );
  const stop = logOf(place, "ops.log").find(({ op }) => op === "stop");
  assert.equal(stop?.code, "error");
  assert.equal(stop?.reason, `the author's session failed: ${MODEL_NOT_FOUND}`);
  const session = sessionOf(statusOf(place));
  assert.equal(session.outcome, "failed");
});
