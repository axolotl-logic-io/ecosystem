// @ts-check
// sync-base and finish-sync for a stacked branch (#268), one cut from its
// prerequisite issue's branch: while the prerequisite is open the branch is
// rebased onto that branch's head, and once it has merged onto the base.
// Their replies and the branch on origin, run through the ops CLI against a
// local origin.
import assert from "node:assert/strict";
import { test } from "node:test";
import { okLine, opsFixture } from "./ops-fixture.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */

const fx = await opsFixture("sync-ops-stacked");
const { fakeGh, originRef, sh, worktree } = fx;
// Each test's prerequisite and the issue stacked on it.
const ISSUE = {
  movedPrereq: { prereq: 50, dependent: 51 },
  mergedPrereq: { prereq: 52, dependent: 53 },
  onPrereq: { prereq: 54, dependent: 55 },
  offPrereq: { prereq: 56, dependent: 57 },
};
const MERGED_PR = 90;
// The prerequisite's file after its second commit.
const PREREQ_TEXT = "prereq\nmore";

// What a branch with a code change and no wiki reports.
const CODE = { codeChanged: true, wikiAhead: 0 };

// Runs an op with gh answering `replies`; returns its stdout.
/** @param {object} request @param {readonly GhReply[]} [replies] @returns {string} */
function ask(request, replies = []) {
  fakeGh.reply(replies);
  return fx.ask(request);
}

/** @param {string} ancestor @param {string} sha @returns {boolean} */
function isAncestor(ancestor, sha) {
  const check = `git -C ${fx.root}/origin.git merge-base --is-ancestor ${ancestor} ${sha}`;
  return sh(`${check} && echo yes || echo no`) === "yes";
}

// Starts `prereq`'s branch with two commits to one file, then `dependent`'s
// branch on it with one commit of its own, all pushed. Returns the
// prerequisite's head. Replaying the prerequisite's first commit onto a
// rewritten or squashed copy of its branch conflicts, so only a rebase that
// replays the dependent's own commit alone (`--onto`) runs clean.
/** @param {{ prereq: number, dependent: number }} pair @returns {string} */
function stackedPair({ prereq, dependent }) {
  fx.startBranch(prereq, `p${prereq}`, "prereq");
  fx.commitIn(prereq, `p${prereq}`, PREREQ_TEXT);
  const prereqHead = fx.pushFrom(prereq);
  fx.fetchClone();
  sh(
    `git -C ${fx.root}/clones/o__r worktree add -q -B agent/issue-${dependent} ${worktree(dependent)} ${prereqHead}`,
  );
  fx.commitIn(dependent, `d${dependent}`, "own");
  fx.pushFrom(dependent);
  return prereqHead;
}

test("sync-base rebases a stacked branch onto its open prerequisite's rewritten head", () => {
  const { prereq, dependent } = ISSUE.movedPrereq;
  const before = stackedPair(ISSUE.movedPrereq);
  // The prerequisite's branch is rewritten: one new commit on the base.
  sh(`git -C ${worktree(prereq)} reset -q --hard origin/integration`);
  fx.commitIn(prereq, `p${prereq}`, "prereq rewritten");
  const moved = fx.pushFrom(prereq);
  const stackedOn = { issue: prereq, headSha: before };
  const out = ask({ op: "sync-base", number: dependent, stackedOn });
  const headSha = originRef(`agent/issue-${dependent}`);
  assert.equal(originRef(`${headSha}^`), moved);
  assert.equal(isAncestor(before, headSha), false);
  assert.equal(
    out,
    okLine("sync-base", {
      changed: true,
      conflict: false,
      headSha,
      ...CODE,
      stackedOn: { issue: prereq, headSha: moved },
    }),
  );
});

test("sync-base rebases onto the base once the prerequisite's PR merged, and unstacks", () => {
  const { prereq, dependent } = ISSUE.mergedPrereq;
  const prereqHead = stackedPair(ISSUE.mergedPrereq);
  // The base gains a squash of the prerequisite's two commits (advanceBase
  // writes through printf, which reads `\n` as a newline).
  const base = fx.advanceBase(`p${prereq}`, "prereq\\nmore");
  const merged = {
    when: "merged",
    stdout: JSON.stringify([{ number: MERGED_PR }]),
  };
  const stackedOn = { issue: prereq, headSha: prereqHead };
  const out = ask({ op: "sync-base", number: dependent, stackedOn }, [merged]);
  const headSha = originRef(`agent/issue-${dependent}`);
  assert.equal(originRef(`${headSha}^`), base);
  assert.equal(isAncestor(prereqHead, headSha), false);
  assert.equal(
    out,
    okLine("sync-base", {
      changed: true,
      conflict: false,
      headSha,
      ...CODE,
      stackedOn: null,
    }),
  );
});

test("finish-sync of a stacked branch accepts a rebase on the prerequisite's head", () => {
  const { prereq, dependent } = ISSUE.onPrereq;
  const prereqHead = stackedPair(ISSUE.onPrereq);
  fx.commitIn(dependent, `d${dependent}`, "resolved");
  const stackedOn = { issue: prereq, headSha: prereqHead };
  const out = ask({ op: "finish-sync", number: dependent, stackedOn });
  const headSha = originRef(`agent/issue-${dependent}`);
  assert.equal(
    out,
    okLine("finish-sync", { resolved: true, headSha, ...CODE }),
  );
  assert.equal(isAncestor(prereqHead, headSha), true);
});

test("finish-sync of a stacked branch refuses a rebase that isn't on the prerequisite's head", () => {
  const { prereq, dependent } = ISSUE.offPrereq;
  const prereqHead = stackedPair(ISSUE.offPrereq);
  const pushed = originRef(`agent/issue-${dependent}`);
  // A resolution that dropped the prerequisite: on the base only.
  sh(`git -C ${worktree(dependent)} reset -q --hard origin/integration`);
  fx.commitIn(dependent, `d${dependent}`, "resolved");
  const stackedOn = { issue: prereq, headSha: prereqHead };
  const out = ask({ op: "finish-sync", number: dependent, stackedOn });
  assert.equal(
    out,
    okLine("finish-sync", {
      resolved: false,
      reason: `HEAD is not based on ${prereqHead}`,
    }),
  );
  assert.equal(originRef(`agent/issue-${dependent}`), pushed);
});
