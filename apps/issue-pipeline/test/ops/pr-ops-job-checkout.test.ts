// start-pr from a stage job: its empty commit passes the job checkout's
// pre-commit hook (Pipeline-Job-Contract#pipeline_commit), and the branch
// on origin starts with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { draftMutationReplies } from "../gh-mutation-fixtures.ts";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
} from "../initial-write-state-fixtures.ts";
import type { OpsFixture } from "../ops-fixtures.ts";
import { okLine, opsFixture } from "../ops-fixtures.ts";

const fx: OpsFixture = await opsFixture("pr-ops-job-checkout");
fx.fakeGh.requireReplies();
const { loadConfig }: typeof import("../../src/config.ts") = await import(
  "../../src/config.ts"
);
const { openJobCheckout }: typeof import("../../src/job/checkout.ts") =
  await import("../../src/job/checkout.ts");
const { fakeGh, ask, originRef, root }: OpsFixture = fx;

const ISSUE = 12;
const PR = 62;

// Returns the subject of `ref` on origin
function subjectOf(ref: string): string {
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
