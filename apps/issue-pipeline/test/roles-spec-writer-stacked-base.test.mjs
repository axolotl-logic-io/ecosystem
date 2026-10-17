// @ts-check
// A stacked spec's checks read one base for the whole of its spec (#401):
// with the spec writer's real checks on bare origins, a spec stacked on #6
// whose branch the stage created (null start heads) and whose prerequisite
// has since been squash-merged into the base lists, checks and confirms only
// its own commits, whether #6's branch was deleted, kept, or rebased before
// its merge. Another issue's merge lands on the base before #6's, as a base
// moves. A spec with no prerequisite still measures from the base. Every run
// is made before the tests, because the fake gh's writes are global.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BASE } from "./job-git-test-kit.mjs";
import { specWriter } from "./spec-writer-git-test-kit.mjs";
import { replyOf } from "./spec-writer-role-test-kit.mjs";

/** @typedef {Awaited<ReturnType<typeof specWriter>>} Ran */
/** @typedef {Readonly<Record<string, string>>} Files */
/** @typedef {"deleted" | "kept" | "rebased"} Prereq */

const IDENTITY = [
  "-c",
  "user.name=Seed",
  "-c",
  "user.email=seed@example.com",
  "-c",
  "commit.gpgsign=false",
];
const SPEC_TRAILER = "Pipeline-Agent: spec writer";
// The issue #7 is stacked on.
const PREREQ = 6;
const SPEC_TEST = "test/quota.test.sh";
const STUB = "src/quota.ts";
// The prerequisite's own change, one commit per file: neither is a test file
// or the stub of a new interface, so the commit check fails if it counts them.
const PREREQ_FILES = {
  "apps/README.md": "The prerequisite's README.\n",
  "src/prereq.ts": "export const prereq = 1;\n",
};
// Another issue's change, merged into the base before the prerequisite's.
const OTHER = { "src/other.ts": "export const other = 1;\n" };
// The heads a branch the stage created saves.
const CREATED = { startSha: null, startWikiSha: null };
// A ready reply whose one new interface's stub is STUB.
const READY = replyOf();
const NO_WORK = replyOf({ decision: "no-work" });
const SAVED_AT_IMPLEMENT = { kind: "saved", stage: "implement" };

/** @param {string} dir @param {readonly string[]} args @returns {string} git's trimmed stdout */
function git(dir, args) {
  return execFileSync("git", [...IDENTITY, "-C", dir, ...args], {
    encoding: "utf8",
  }).trim();
}

/** @param {string} dir @param {Files} files @param {readonly string[]} message commits `files` in `dir` */
function commitFiles(dir, files, message) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", ...message.flatMap((line) => ["-m", line])]);
}

/** @param {string} origin @returns {{ dir: string, start: string }} a clone of `origin` at the base, and the base's head */
function cloneOf(origin) {
  const dir = `${origin}-stack`;
  execFileSync("git", ["clone", "--quiet", "--branch", BASE, origin, dir]);
  return { dir, start: git(dir, ["rev-parse", "HEAD"]) };
}

/**
 * Builds #6's branch with its own commits, #7's branch on its head with the
 * spec's commit when `specFiles` has any, another issue's merge on the base,
 * then #6's squash-merge into the base; #6's branch is then deleted, kept, or
 * kept after a rebase onto the base before its merge, as `prereq` says.
 * @param {string} origin
 * @param {Prereq} prereq
 * @param {Files} specFiles
 * @returns {Record<string, unknown>} the state a stacked spec saved at its start
 */
function mergedPrereq(origin, prereq, specFiles) {
  const { dir, start } = cloneOf(origin);
  git(dir, ["checkout", "--quiet", "-b", "prereq"]);
  for (const [file, text] of Object.entries(PREREQ_FILES)) {
    commitFiles(dir, { [file]: text }, [`#${PREREQ}: ${file}`]);
  }
  const prereqRef = `refs/heads/agent/issue-${PREREQ}`;
  git(dir, ["push", "--quiet", "origin", `HEAD:${prereqRef}`]);
  const headSha = git(dir, ["rev-parse", "HEAD"]);
  if (Object.keys(specFiles).length > 0) {
    commitFiles(dir, specFiles, ["spec", SPEC_TRAILER]);
  }
  git(dir, ["push", "--quiet", "origin", "HEAD:refs/heads/agent/issue-7"]);
  git(dir, ["checkout", "--quiet", BASE]);
  commitFiles(dir, OTHER, ["Another issue's merge"]);
  if (prereq === "rebased") {
    git(dir, ["rebase", "--quiet", "--onto", BASE, start, "prereq"]);
    git(dir, ["push", "--quiet", "--force", "origin", `HEAD:${prereqRef}`]);
    git(dir, ["checkout", "--quiet", BASE]);
  }
  git(dir, ["merge", "--quiet", "--squash", "prereq"]);
  git(dir, ["commit", "--quiet", "-m", `#${PREREQ} squashed (#95)`]);
  git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${BASE}`]);
  if (prereq === "deleted") {
    git(dir, ["push", "--quiet", "origin", `:${prereqRef}`]);
  }
  return {
    stackedOn: { issue: PREREQ, headSha },
    checkpoints: CREATED,
  };
}

/**
 * Builds #7's branch on the base with the spec's test, then moves the base on
 * with another issue's merge.
 * @param {string} origin
 * @returns {Record<string, unknown>} the state an unstacked spec saved at its start
 */
function movedBase(origin) {
  const { dir } = cloneOf(origin);
  commitFiles(dir, { [SPEC_TEST]: "exit 1\n" }, ["spec", SPEC_TRAILER]);
  git(dir, ["push", "--quiet", "origin", "HEAD:refs/heads/agent/issue-7"]);
  git(dir, ["reset", "--quiet", "--hard", "HEAD~1"]);
  commitFiles(dir, OTHER, ["Another issue's merge"]);
  git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${BASE}`]);
  return { checkpoints: CREATED };
}

/** @param {Prereq} prereq @returns {Promise<Ran>} a ready run of the stacked spec, whose session adds the stub */
function readyAfterMerge(prereq) {
  return specWriter({
    replies: [READY],
    code: { [STUB]: "export function parseQuota() {}\n" },
    prepare: (origin) =>
      mergedPrereq(origin, prereq, { [SPEC_TEST]: "exit 1\n" }),
  });
}

// Every file a run could list as already committed.
const LISTABLE = [
  SPEC_TEST,
  ...Object.keys(PREREQ_FILES),
  ...Object.keys(OTHER),
];

/** @param {Ran} ran @returns {string[]} the files the first session was told are already committed */
function shownCommitted(ran) {
  const task = String(ran.tasks[0]);
  return LISTABLE.filter((file) => task.includes(`\`${file}\``));
}

/** @param {Ran} ran @returns {{ end: unknown, stopReason: unknown, shown: string[] }} how the run ended and what it listed */
function outcomeOf(ran) {
  const { stopReason } = ran.saved;
  return { end: ran.end, stopReason, shown: shownCommitted(ran) };
}

// A run that listed and checked only the spec's own commits.
const OWN_COMMITS_ONLY = {
  end: SAVED_AT_IMPLEMENT,
  stopReason: undefined,
  shown: [SPEC_TEST],
};

const deleted = await readyAfterMerge("deleted");
const kept = await readyAfterMerge("kept");
const rebased = await readyAfterMerge("rebased");
// The spec's branch is still the prerequisite's head, and the test command
// would fail if the no-work check ran it.
const noWork = await specWriter({
  replies: [NO_WORK],
  testCommand: "exit 1",
  prepare: (origin) => mergedPrereq(origin, "deleted", {}),
});
const fresh = await specWriter({
  replies: [READY],
  code: {
    [SPEC_TEST]: "exit 1\n",
    [STUB]: "export function parseQuota() {}\n",
  },
  stacked: true,
});
const unstacked = await specWriter({
  replies: [READY],
  code: { [STUB]: "export function parseQuota() {}\n" },
  prepare: movedBase,
});

test("a stacked spec whose prerequisite merged and lost its branch lists and checks only its own commits", () => {
  assert.deepEqual(outcomeOf(deleted), OWN_COMMITS_ONLY);
});

test("a stacked spec whose merged prerequisite kept its branch lists and checks only its own commits", () => {
  assert.deepEqual(outcomeOf(kept), OWN_COMMITS_ONLY);
});

test("a stacked spec whose prerequisite was rebased before its merge lists and checks only its own commits", () => {
  assert.deepEqual(outcomeOf(rebased), OWN_COMMITS_ONLY);
});

test("a stacked spec that changed nothing since the prerequisite's head is no work after the prerequisite merged", () => {
  assert.deepEqual(noWork.end, { kind: "stopped", code: "no-work" });
});

test("a branch the stage created saves null start heads", () => {
  assert.deepEqual(fresh.end, SAVED_AT_IMPLEMENT);
  const { startSha, startWikiSha } = fresh.saved.checkpoints ?? {};
  assert.deepEqual({ startSha, startWikiSha }, CREATED);
});

test("an unstacked spec measures from the base branch after the base moved", () => {
  assert.deepEqual(outcomeOf(unstacked), OWN_COMMITS_ONLY);
});
