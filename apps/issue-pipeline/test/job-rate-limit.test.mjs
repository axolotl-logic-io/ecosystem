// @ts-check
// A stage job whose session hits a model provider's rate limit
// (`rate-limit-defers`) ends finished with `rateLimited` in job.json's
// outcome, which the orchestrator backs off on, and stops nothing: a sweep
// stage (accept) defers its issue with no retry, and a role stage (triage,
// and the spec writer, whose session state takes its own failures, #446)
// ends held, saving the issue at its stage with no attempt counted.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  logOf,
  piCommands,
  repliesAt,
  runJob,
  SWEEP_STAGE,
  setUp,
  statusOf,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

// The error pi gave the sessions of #303, #304 and #316 at 01:02Z.
const COOLING_DOWN =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-5-5 are cooling down via provider claude"}}';
const RATE_LIMITED = { kind: "finished", rateLimited: true };
// The triages issue #7 was claimed with (workflow-stages-fixtures.mjs).
const CLAIMED_TRIAGES = 0;

/** @param {Place} place @returns {string[]} the ops the job asked for */
function opsOf(place) {
  return logOf(place, "ops.log").map(({ op }) => op);
}

test("a sweep stage job whose session hits the rate limit defers with no retry and notes it in job.json", () => {
  const place = setUp(repliesAt(SWEEP_STAGE), { rejectPrompt: COOLING_DOWN });
  const r = runJob(place, ["--stage", SWEEP_STAGE, "--lane", "L"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    piCommands(place).map(({ type }) => type),
    ["prompt"],
  );
  const [item] = JSON.parse(r.stdout).items;
  assert.equal(item.outcome, "rate-limited");
  assert.equal(opsOf(place).includes("stop"), false);
  assert.deepEqual(statusOf(place)?.outcome, RATE_LIMITED);
});

test("a triage job whose session hits the rate limit ends held, saved at triage with no triage counted", () => {
  const place = setUp(repliesAt("triage"), { rejectPrompt: COOLING_DOWN });
  const r = runJob(place, ["--stage", "triage"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).end, {
    kind: "held",
    rateLimited: true,
  });
  assert.equal(opsOf(place).includes("stop"), false);
  const saves = logOf(place, "ops.log").filter(({ op }) => op === "save-state");
  const { stage, lease, triages } = saves.at(-1)?.state ?? {};
  assert.deepEqual(
    { stage, lease, triages },
    { stage: "triage", lease: null, triages: CLAIMED_TRIAGES },
  );
  assert.deepEqual(statusOf(place)?.outcome, RATE_LIMITED);
});

// #446: the spec writer's session state lists `failed`, so a rate limit used
// its one retry, and the second stopped it as failed twice.
test("a spec job whose session hits the rate limit ends held, saved at spec with no attempt counted", () => {
  const place = setUp(repliesAt("spec"), { rejectPrompt: COOLING_DOWN });
  const r = runJob(place, ["--stage", "spec"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).end, {
    kind: "held",
    rateLimited: true,
  });
  assert.equal(opsOf(place).includes("stop"), false);
  const prompts = piCommands(place).filter(({ type }) => type === "prompt");
  assert.equal(prompts.length, 1);
  const saves = logOf(place, "ops.log").filter(({ op }) => op === "save-state");
  const { stage, lease, checkpoints } = saves.at(-1)?.state ?? {};
  assert.deepEqual({ stage, lease }, { stage: "spec", lease: null });
  assert.equal(checkpoints?.attempts ?? 0, 0);
  assert.deepEqual(statusOf(place)?.outcome, RATE_LIMITED);
});
