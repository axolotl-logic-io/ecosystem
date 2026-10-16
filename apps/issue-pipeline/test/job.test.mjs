// The stage job end to end, through job-test-kit.mjs: a fake ops.mjs and a
// fake RPC pi log what they were asked, so the tests see the ops requested,
// every pi command line and every command pi read.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkoutOf } from "./job-git-test-kit.mjs";
import {
  alive,
  flagValue,
  logOf,
  piCommands,
  piStarts,
  repliesAt,
  runJob,
  SPEC_SESSION,
  sessionOf,
  setUp,
  statusOf,
  USAGE_SPENT,
} from "./job-test-kit.mjs";
import { ISSUE } from "./workflow-stages-fixtures.mjs";

const SESSION_KEY = /^i7-spec-\d+\.jsonl$/u;
const SET_ASIDE_SESSION = /^i7-spec-\d+\.[0-9a-z]+\.jsonl$/u;
const NAMES_REVIEW = /review/u;
const NAMES_SPEC = /spec/u;
const STAGE_LIST = /--stage must be one of: triage, spec/u;
const STAGE_ARGS = ["--stage", "spec", "--lane", "L"];
const MODEL_NOT_FOUND = "Model not found: x/y";

test("a stage job runs the spec stage, releases the issue at implement and prints one summary line", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const ops = logOf(place, "ops.log");
  const sweep = ops.find(({ op }) => op === "sweep");
  assert.equal(sweep.only, ISSUE);
  assert.equal(sweep.lane, "L");
  const release = ops.find(({ op }) => op === "release");
  assert.equal(release.state.stage, "implement");
  assert.equal(release.state.reportedTokens, USAGE_SPENT);
  const calls = piStarts(place);
  assert.equal(calls.length, 1);
  const [{ argv, cwd }] = calls;
  assert.equal(cwd, checkoutOf(fs.realpathSync(place.root), "spec"));
  assert.equal(flagValue(argv, "--mode"), "rpc");
  const [prompt, ...others] = piCommands(place);
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
  const summary = JSON.parse(lines[0] ?? "");
  assert.equal(summary.lane, "L");
  assert.equal(summary.items[0].issue, ISSUE);
  assert.equal(summary.items[0].stage, "implement");
});

test("a second stage job for the same stage starts a fresh pi session and keeps the first aside", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
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

test("a stage job for an issue saved at another stage releases it untouched as wrong-stage", () => {
  const place = setUp(repliesAt("review"), { events: [] });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const ops = logOf(place, "ops.log").map(({ op }) => op);
  assert.ok(ops.includes("release"), ops.join(","));
  assert.ok(!ops.includes("save-state"), ops.join(","));
  assert.deepEqual(logOf(place, "pi.log"), []);
  const [item] = JSON.parse(r.stdout).items;
  assert.equal(item.outcome, "wrong-stage");
  assert.match(item.reason, NAMES_REVIEW);
  assert.match(item.reason, NAMES_SPEC);
});

test("a stage job with an unknown stage fails before any op", () => {
  const place = setUp(repliesAt("spec"), { events: [] });
  const r = runJob(place, ["--stage", "nope"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, STAGE_LIST);
  assert.equal(r.stdout, "");
  assert.deepEqual(logOf(place, "ops.log"), []);
});

test("a rejected prompt ends pi's session, and its error fails the launch", () => {
  const place = setUp(repliesAt("spec"), { rejectPrompt: MODEL_NOT_FOUND });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  // One prompt per session: the spec stage tries a failed session once more
  // (#280).
  assert.deepEqual(
    piCommands(place).map(({ type }) => type),
    ["prompt", "prompt"],
  );
  // The fake pi exits only once its stdin closes.
  const starts = piStarts(place);
  assert.deepEqual(
    starts.map(({ pid }) => alive(pid)),
    [false, false],
  );
  const stop = logOf(place, "ops.log").find(({ op }) => op === "stop");
  assert.equal(stop?.detail, MODEL_NOT_FOUND);
  const session = sessionOf(statusOf(place));
  assert.equal(session.outcome, "failed");
});
