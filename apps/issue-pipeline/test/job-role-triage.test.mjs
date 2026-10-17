// @ts-check
// `job.mjs --stage triage` runs the triage role (#304) as a reader stage:
// --resume is refused before anything is claimed, and a ready reply saves
// the issue at spec, gives pi no gh token, pushes nothing and removes the
// checkout.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import { checkoutOf, refOf } from "./job-git-test-kit.mjs";
import {
  logOf,
  piStarts,
  repliesAt,
  runJob,
  setUp,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const BRANCH = "refs/heads/agent/issue-7";
// The push the fake ops makes for real from the request's checkout.
const PUSHING = { push: { ok: true, git: true } };
const RESUME_REFUSED = /--resume doesn't apply to stage triage/u;
const GH_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
// Every gh token variable, each with its own secret.
const GH_ENV = Object.fromEntries(
  GH_VARS.map((name) => [name, `${name.toLowerCase()}-secret`]),
);
// The structured output of a triage agent that finds the issue ready.
const READY_TRIAGE = {
  decision: "ready",
  reason: "Small.",
  questions: [],
  plan: "Change src/a.ts and test it.",
};
// A triage session that commits a file, spends USAGE and finds the issue ready.
const TRIAGE_SESSION = {
  commit: "work.txt",
  events: [messageEnd(USAGE), outputEnd(READY_TRIAGE)],
};

/** @returns {Place} issue #7 claimed at triage, with pushes made for real */
function triagePlace() {
  return setUp({ ...repliesAt("triage"), ...PUSHING }, TRIAGE_SESSION);
}

/** @param {Place} place @returns {string} the last sha pi committed */
function committed(place) {
  const entries = logOf(place, "pi.log").filter((line) => "committed" in line);
  return entries.at(-1)?.committed ?? "";
}

/** @param {Place} place @returns {any[]} the ops requests the job made */
function opsOf(place) {
  return logOf(place, "ops.log");
}

test("--resume is refused for triage before anything is claimed", () => {
  const place = triagePlace();
  const r = runJob(place, ["--stage", "triage", "--resume"], GH_ENV);
  assert.equal(r.status, 1);
  assert.match(r.stderr, RESUME_REFUSED);
  assert.deepEqual(opsOf(place), []);
  assert.equal(statusOf(place), null);
});

test("a ready triage saves the issue at spec, with no gh token for pi and nothing pushed", () => {
  const place = triagePlace();
  const r = runJob(place, ["--stage", "triage"], GH_ENV);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    issue: 7,
    stage: "triage",
    end: { kind: "saved", stage: "spec" },
  });
  const [start, ...more] = piStarts(place);
  assert.deepEqual(more, []);
  for (const name of GH_VARS) {
    assert.ok(!start.env.includes(name), name);
  }
  assert.equal(start.ghToken, null);
  const saves = opsOf(place).filter(({ op }) => op === "save-state");
  const last = saves.at(-1)?.state;
  assert.equal(last.stage, "spec");
  assert.equal(last.lease, null);
  assert.notEqual(committed(place), "");
  assert.deepEqual(
    opsOf(place).filter(({ op }) => op === "push"),
    [],
  );
  assert.equal(refOf(place.origin, BRANCH), "");
  assert.equal(fs.existsSync(checkoutOf(place.root, "triage")), false);
});
