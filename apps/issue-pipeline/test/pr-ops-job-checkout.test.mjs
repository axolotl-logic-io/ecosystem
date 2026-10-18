// @ts-check
// start-pr from a stage job: its empty commit passes the job checkout's
// pre-commit hook (Pipeline-Roles-Shared, "pipeline_commit"), and the branch
// on origin starts with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { draftMutationReplies } from "./gh-mutation-fixtures.mjs";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
} from "./initial-write-state-fixtures.mjs";
import { okLine, opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("pr-ops-job-checkout");
fx.fakeGh.requireReplies();
const { loadConfig } = await import("../src/config.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { fakeGh, ask, originRef, root } = fx;

const ISSUE = 12;
const PR = 62;

/** @param {string} ref @returns {string} the subject of `ref` on origin */
function subjectOf(ref) {
  const args = ["--git-dir", `${root}/origin.git`, "log", "-1", "--format=%s"];
  return execFileSync("git", [...args, ref], { encoding: "utf8" }).trim();
}

test("start-pr in a job checkout commits past its pre-commit hook and pushes the branch", () => {
  const cfg = loadConfig(`${root}/config.json`);
  const { repo: dir } = openJobCheckout(cfg, ISSUE, {
    stage: "implement",
    branch: `agent/issue-${ISSUE}`,
  });
  fakeGh.reply([
    initialWriteStateReply(ISSUE),
    ...draftMutationReplies(ISSUE, PR),
    historyReply(ISSUE),
    openDraftReply(ISSUE, PR, `${root}/origin.git`),
    { when: `repos/o/r/issues/${ISSUE}`, stdout: '{"title":"T"}' },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${PR}\n` },
  ]);
  const checkout = { issue: ISSUE, dir, branch: `agent/issue-${ISSUE}` };
  const out = ask({ op: "start-pr", number: ISSUE, checkout });
  const headSha = originRef(`agent/issue-${ISSUE}`);
  assert.equal(out, okLine("start-pr", { pr: PR, headSha }));
  assert.equal(subjectOf(headSha), `Start work on #${ISSUE}`);
});
