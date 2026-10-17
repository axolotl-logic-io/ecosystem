// @ts-check
// The spec writer's reset never discards a person's work (#334): with its real
// checks on bare origins, a needs-info reply resets the code and wiki
// branches only when they hold nothing but the spec writer's own commits, as
// the job last knew them. A person's commits pushed before the run, which a
// start head saved by an earlier run would rewind past, or pushed during it,
// stop the issue and stay on both branches. Every run is made before the
// tests, because the fake gh's writes are global.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { refOf } from "./job-git-test-kit.mjs";
import { BRANCH, specWriter } from "./spec-writer-git-test-kit.mjs";
import { replyOf } from "./spec-writer-role-test-kit.mjs";

/** @typedef {Awaited<ReturnType<typeof specWriter>>} Ran */

const CODE = { "test/quota.test.sh": "exit 1\n" };
const WIKI = { "Quota.md": "Quota.\n" };
const NEEDS_INFO = replyOf({ decision: "needs-info", questions: ["Why?"] });
const STOPPED = { kind: "stopped", code: "error" };

/** @param {string} bare @returns {string[]} the subjects of the issue's branch on `bare`, newest first */
function subjectsOf(bare) {
  const args = ["-C", bare, "log", "--format=%s", BRANCH];
  return execFileSync("git", args, { encoding: "utf8" }).trim().split("\n");
}

/** @param {Ran} ran @returns {string[][]} the subjects of the code and wiki branches */
function branchSubjects(ran) {
  const { origin, wikiOrigin } = ran.repo;
  return [subjectsOf(origin), subjectsOf(wikiOrigin)];
}

/** @param {Ran} ran @returns {boolean} whether the run asked its questions */
function asked(ran) {
  return ran.labels.includes("agent:needs-info");
}

// An earlier run found no branch, and a person pushed one since.
const pushedBefore = await specWriter({
  replies: [NEEDS_INFO],
  code: CODE,
  wiki: WIKI,
  existing: true,
  start: { checkpoints: { startSha: null, startWikiSha: null } },
});
const pushedDuring = await specWriter({
  replies: [NEEDS_INFO],
  code: CODE,
  wiki: WIKI,
  pushedMeanwhile: true,
});

test("a person's commits from before the run stop the reset and stay on both branches", () => {
  assert.deepEqual(pushedBefore.end, STOPPED);
  assert.ok(!asked(pushedBefore));
  for (const subjects of branchSubjects(pushedBefore)) {
    assert.deepEqual(subjects.slice(0, 2), ["spec", "earlier"]);
  }
});

test("a person's push during the run stops the reset and stays on both branches", () => {
  assert.deepEqual(pushedDuring.end, STOPPED);
  assert.ok(!asked(pushedDuring));
  const { origin, wikiOrigin } = pushedDuring.repo;
  assert.notEqual(refOf(origin, BRANCH), "");
  assert.notEqual(refOf(wikiOrigin, BRANCH), "");
  for (const subjects of branchSubjects(pushedDuring)) {
    assert.deepEqual(subjects.slice(0, 2), ["A person's commit", "spec"]);
  }
});
