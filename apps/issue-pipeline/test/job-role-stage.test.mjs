// @ts-check
// A stage that runs a registered role (#301): --resume is refused before
// anything starts, and a run claims, runs the role, saves only the role's
// declared fields, lists its steps in job.json and removes its checkout.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { checkoutOf } from "./job-git-test-kit.mjs";
import {
  logOf,
  repliesAt,
  runJob,
  SPEC_SESSION,
  setUp,
  statusOf,
} from "./job-test-kit.mjs";

const PRELOAD = new URL("./toy-role-preload.mjs", import.meta.url).pathname;
// Environment variables are named by strings, as the job kit's env is.
const ROLE_ENV = Object.fromEntries([["NODE_OPTIONS", `--import=${PRELOAD}`]]);
/** @import { StepReport } from "../src/job/runner.ts" */

/** @param {StepReport} step a job.json step, less its times */
function briefOf({ at, effect, name, result }) {
  return { at, effect, name, result };
}

const RESUME_REFUSED =
  /job: --resume doesn't apply to stage spec; it restarts from what is done/u;

/** @param {string} a @param {string} b @returns {number} */
function byText(a, b) {
  return a.localeCompare(b);
}

test("--resume is refused for a role stage before anything starts", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
  const r = runJob(place, ["--stage", "spec", "--resume"], ROLE_ENV);
  assert.equal(r.status, 1);
  assert.match(r.stderr, RESUME_REFUSED);
  assert.deepEqual(logOf(place, "ops.log"), []);
  assert.equal(statusOf(place), null);
  assert.equal(fs.existsSync(checkoutOf(place.root, "spec")), false);
});

test("a role stage runs its role and saves only its declared fields", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
  const r = runJob(place, ["--stage", "spec"], ROLE_ENV);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    issue: 7,
    stage: "spec",
    end: { kind: "saved", stage: "implement" },
  });
  const ops = logOf(place, "ops.log").map(({ op }) => op);
  assert.deepEqual(ops.slice(0, 2), ["claim", "post"]);
  const { steps } = statusOf(place);
  assert.deepEqual(steps.map(briefOf), [
    { at: "announce", effect: "op", name: "post", result: "ok" },
  ]);
  assert.equal(typeof steps[0].endedAt, "string");
  const saves = logOf(place, "ops.log").filter(({ op }) => op === "save-state");
  const { claim } = repliesAt("spec");
  const claimed = Object.keys(Reflect.get(claim, "state"));
  const declared = [...new Set([...claimed, "note", "checkpoints"])].sort(
    byText,
  );
  assert.ok(saves.length > 0);
  for (const { state } of saves) {
    assert.deepEqual(Object.keys(state).sort(byText), declared);
  }
  const last = saves.at(-1)?.state;
  assert.equal(last.stage, "implement");
  assert.equal(last.lease, null);
  assert.equal(last.note, "noted");
  assert.deepEqual(last.checkpoints, { count: 1 });
  assert.equal(fs.existsSync(checkoutOf(place.root, "spec")), false);
});
