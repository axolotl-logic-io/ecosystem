// @ts-check
// The queue's read of whether a waiting issue's stackable prerequisite is
// behind (#328): its branch on GitHub lacks the merge commit of another
// prerequisite in the issue's after mark whose PR merged. A failed read
// counts as not behind, and the rest of the queue is still read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { cfg, NOW, openWith, root } from "./orchestrator-world-test-kit.mjs";

const { readQueue } = await import("../src/orchestrator/snapshot.ts");
const { paths } = await import("../src/config.ts");

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { Prereq, SnapshotIssue } from "../src/orchestrator/queue.ts" */

// The open prerequisite, the closed one whose PR merged, the dependent that
// waits on both, and a second prerequisite the rebase test moves.
const PREREQ = 30;
const MERGED = 31;
const DEPENDENT = 32;
const REBASED = 33;
const MERGED_PR = 41;
const SEED = `${root}/behind-seed`;
const COMMIT = "git -c user.email=a@b -c user.name=a commit -q";

/** @param {string} command @returns {string} */
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// Pushes issue `n`'s branch on origin with one commit of its own, cut from
// the base's head now.
/** @param {number} n @returns {void} */
function pushPrereq(n) {
  sh(
    `cd ${SEED} && git checkout -qb agent/issue-${n} integration && echo ${n} > prereq-${n} && git add prereq-${n} && ${COMMIT} -m "prereq ${n}" && git push -q origin agent/issue-${n}`,
  );
}

// The orchestrator's host has the shared clone, cloned before any branch here
// was pushed, so the read must fetch what it compares.
sh(`git clone -q ${root}/origin.git ${paths.clone(cfg)}`);
sh(`git clone -q ${root}/origin.git ${SEED}`);
pushPrereq(PREREQ);
pushPrereq(REBASED);
// MERGED's PR merges into the base after both branches were cut: its merge
// commit, which neither branch holds.
sh(
  `cd ${SEED} && git checkout -q integration && ${COMMIT} --allow-empty -m "Merge #${MERGED}" && git push -q origin integration`,
);
const MERGE_COMMIT = sh(`git -C ${SEED} rev-parse integration`);
const MERGED_REPLY = JSON.stringify([
  { number: MERGED_PR, mergeCommit: { oid: MERGE_COMMIT } },
]);

// Gh's answer to MERGED's merged-PR lookup, `stdout` printed and `code`
// exited with.
/** @param {string} stdout @param {number} [code] @returns {GhReply} */
function mergedLookup(stdout, code = 0) {
  return {
    when: `agent/issue-${MERGED} --state merged`,
    stdout,
    code,
    keep: true,
  };
}

// The queue, with `prereq` at checks with no findings and the dependent's
// after mark naming it and MERGED, MERGED's lookup answered by `lookup`.
/** @param {number} prereq @param {GhReply} lookup @returns {SnapshotIssue[]} */
function readWith(prereq, lookup) {
  openWith(
    [
      { number: prereq, state: { stage: "checks", findings: [] } },
      {
        number: DEPENDENT,
        body: `<!-- agent-pipeline:after ${prereq},${MERGED} -->`,
      },
    ],
    [lookup],
  );
  return readQueue(cfg, [], NOW).issues;
}

// Whether the dependent's open prerequisite reads as behind, or null when it
// has no open prerequisite.
/** @param {number} prereq @param {GhReply} lookup @returns {boolean | null} */
function behindWith(prereq, lookup) {
  const dependent = readWith(prereq, lookup).find(
    (issue) => issue.number === DEPENDENT,
  );
  /** @type {Prereq | null | undefined} */
  const found = dependent?.prereq;
  if (found?.status === "open") {
    return found.behind;
  }
  return null;
}

test("a stackable prerequisite whose branch lacks another merged prerequisite's merge commit is behind", () => {
  assert.equal(behindWith(PREREQ, mergedLookup(MERGED_REPLY)), true);
});

test("once the prerequisite's branch is rebased onto a base that holds the merge commit, it isn't behind, even after the base moves on", () => {
  assert.equal(behindWith(REBASED, mergedLookup(MERGED_REPLY)), true);
  sh(
    `cd ${SEED} && git checkout -q agent/issue-${REBASED} && git rebase -q integration && git push -qf origin agent/issue-${REBASED}`,
  );
  assert.equal(behindWith(REBASED, mergedLookup(MERGED_REPLY)), false);
  // An unrelated commit lands on the base after the rebase: the branch lacks
  // the base's head but holds the merge commit, so it still isn't behind.
  sh(
    `cd ${SEED} && git checkout -q integration && ${COMMIT} --allow-empty -m "unrelated" && git push -q origin integration`,
  );
  assert.notEqual(sh(`git -C ${SEED} rev-parse integration`), MERGE_COMMIT);
  assert.equal(behindWith(REBASED, mergedLookup(MERGED_REPLY)), false);
});

test("an after-mark issue with no merged PR doesn't make the prerequisite behind", () => {
  assert.equal(behindWith(PREREQ, mergedLookup("[]")), false);
});

test("a merged-PR lookup gh fails on reads as not behind, and the rest of the queue is still read", () => {
  const failing = mergedLookup("", 1);
  assert.equal(behindWith(PREREQ, failing), false);
  const numbers = readWith(PREREQ, failing).map((issue) => issue.number);
  assert.deepEqual(numbers, [PREREQ, DEPENDENT]);
});
