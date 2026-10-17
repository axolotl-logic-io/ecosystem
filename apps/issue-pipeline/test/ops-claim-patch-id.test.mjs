// @ts-check
// The claim op's restart of an issue whose branch was pushed since its review
// (#394, review-keeps-on-clean-rebase): a clean rebase leaves the issue's
// changes, and so their patch id, as the review passed them, and the restart
// continues at the stage that stopped; an edit or a conflict resolution that
// changes the issue's hunk changes the patch id, and the restart goes back
// to review. Run against a local origin and the fake gh.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { stateOf } from "./gh-effects.mjs";
import { issueReply, LANE, LIVE } from "./ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  effects,
  reply,
  root,
  sh,
  stateComment,
  TIME,
} from "./ops-cli-test-kit.mjs";

const SEED = `${root}/seed`;
const CLONE = `${root}/clones/o__r`;
// Each test's issue, its claim and state comments' ids, and its PR.
const ISSUE = { rebase: 80, edit: 81, conflict: 82 };
const PR_OFFSET = 500;
const KEPT = /review kept: changes unchanged since/u;

const CLAIM_REPLY = z.looseObject({ ok: z.literal(true) });
const SAVED = z.looseObject({ stage: z.string(), log: z.array(z.string()) });

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${CLONE}`);

// Runs `command` in the seed clone, which pushes to origin.
/** @param {string} command @returns {string} */
function seed(command) {
  return sh(`cd ${SEED} && ${command}`);
}

// Commits `text` as `file` on the seed's checked-out branch.
/** @param {string} file @param {string} text @returns {void} */
function commitFile(file, text) {
  seed(
    `printf '${text}' > ${file} && git add ${file} && git commit -qm ${file}`,
  );
}

// Pushes the seed's head as issue `n`'s branch; returns the head.
/** @param {number} n @returns {string} */
function pushBranch(n) {
  seed(`git push -q -f origin HEAD:refs/heads/agent/issue-${n}`);
  return seed("git rev-parse HEAD");
}

// Gives issue `n` a branch off the base that writes its file; returns the
// head and the patch id git gives its changes.
/** @param {number} n @returns {{ head: string, patchId: string }} */
function issueBranch(n) {
  seed("git fetch -q origin");
  seed(`git checkout -q -B agent/issue-${n} origin/integration`);
  commitFile(`p-${n}`, "a\\nb\\nc\\n");
  const head = pushBranch(n);
  const ids = seed(
    "git diff --binary origin/integration HEAD | git patch-id --verbatim",
  );
  const [patchId = ""] = ids.split(" ");
  return { head, patchId };
}

// Moves the base on by committing `text` as `file` on it.
/** @param {string} file @param {string} text @returns {void} */
function advanceBase(file, text) {
  seed("git fetch -q origin");
  seed("git checkout -q -B base-moves origin/integration");
  commitFile(file, text);
  seed("git push -q origin HEAD:integration");
}

// Rebases issue `n`'s branch onto the moved base in the seed, cleanly.
/** @param {number} n @returns {void} */
function rebaseBranch(n) {
  seed(`git checkout -q agent/issue-${n}`);
  seed("git fetch -q origin && git rebase -q origin/integration");
}

// Claims issue `n`, stopped at checks after a review of `reviewed` whose
// changes had `patchId`; returns the saved state.
/** @param {number} n @param {{ head: string, patchId: string }} reviewed @returns {{ stage: string, log: string[] }} */
function claimStoppedAtChecks(n, reviewed) {
  const comments = [
    claimComment(n + PR_OFFSET, "me", "s0", LIVE),
    stateComment(n + PR_OFFSET + PR_OFFSET, {
      stage: "stopped",
      stoppedStage: "checks",
      stopCode: "budget",
      lease: null,
      pr: n + PR_OFFSET,
      headSha: reviewed.head,
      reviewedSha: reviewed.head,
      reviewedPatchId: reviewed.patchId,
      verifiedSha: reviewed.head,
      plan: "P",
      spec: "S",
      findings: [],
      log: [`${TIME} stopped`],
    }),
  ];
  reply([
    issueReply(n, { labels: [{ name: "agent:stopped-budget" }] }),
    commentsReply(n, comments),
    { when: "pr list", stdout: JSON.stringify([{ number: n + PR_OFFSET }]) },
    commentsReply(n, comments),
  ]);
  CLAIM_REPLY.parse(askOps({ op: "claim", number: n, ...LANE }));
  const id = n + PR_OFFSET + PR_OFFSET;
  return SAVED.parse(stateOf(effects(), `edit comment ${id} state`));
}

test("a restart after a clean rebase keeps the review and resumes at checks", () => {
  const n = ISSUE.rebase;
  const reviewed = issueBranch(n);
  advanceBase(`base-${n}`, "moved\\n");
  rebaseBranch(n);
  assert.notEqual(pushBranch(n), reviewed.head);
  const saved = claimStoppedAtChecks(n, reviewed);
  assert.equal(saved.stage, "checks");
  assert.ok(saved.log.some((line) => KEPT.test(line)));
});

test("a restart after an edit to the issue's change goes back to review", () => {
  const n = ISSUE.edit;
  const reviewed = issueBranch(n);
  commitFile(`p-${n}`, "a\\nB\\nc\\n");
  pushBranch(n);
  const saved = claimStoppedAtChecks(n, reviewed);
  assert.equal(saved.stage, "review");
  assert.ok(!saved.log.some((line) => KEPT.test(line)));
});

test("a restart after a conflict resolution that changes the issue's hunk goes back to review", () => {
  const n = ISSUE.conflict;
  const reviewed = issueBranch(n);
  advanceBase(`p-${n}`, "a\\nbase\\nc\\n");
  seed(`git checkout -q agent/issue-${n}`);
  seed("git fetch -q origin && (git rebase -q origin/integration || true)");
  seed(`printf 'a\\nb and base\\nc\\n' > p-${n} && git add p-${n}`);
  seed("GIT_EDITOR=true git rebase --continue >/dev/null");
  assert.notEqual(pushBranch(n), reviewed.head);
  const saved = claimStoppedAtChecks(n, reviewed);
  assert.equal(saved.stage, "review");
});
