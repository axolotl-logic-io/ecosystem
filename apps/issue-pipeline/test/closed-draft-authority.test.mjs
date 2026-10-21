// @ts-check
// A closed draft the saved state does not name grants no authority: every
// history of one needs operator recovery, and no code ref changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { refOf } from "./job-git-test-kit.mjs";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  openJob,
} from "./pipeline-commit-test-kit.mjs";
import {
  saveAuthority,
  savePrAuthority,
  savePrHistory,
} from "./write-authority-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");
const { withCheckout } = await import("../src/config.ts");
const { issuePullRequest } = await import("../src/revision.ts");
const { readWriteAuthority } = await import("../src/write-authority.ts");
const { pushHead } = await import("../src/checkouts.ts");
const PR = 42;

async function closedDraft() {
  const job = await openJob("implement");
  const base = headOf(job.repo);
  git(
    job.repo,
    ["commit", "--allow-empty", "-m", "Actual closed draft head"],
    Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
  );
  const original = headOf(job.repo);
  git(job.repo, ["reset", "--hard", base]);
  const state = {
    ...newIssueState(ISSUE),
    stage: "implement",
    branch: job.branch,
    headSha: original,
  };
  const view = {
    number: PR,
    state: "CLOSED",
    headRefName: job.branch,
    headRefOid: original,
    baseRefName: job.cfg.baseBranch,
    isCrossRepository: false,
    mergeCommit: null,
  };
  saveAuthority(job.cfg, state);
  savePrHistory(job.cfg, [{ number: PR }]);
  savePrAuthority(job.cfg, view);
  const cfg = withCheckout(job.cfg, {
    issue: ISSUE,
    branch: job.branch,
    dir: job.repo,
  });
  return { job, cfg, state };
}

const NEEDS_RECOVERY = /closed; code authority needs operator recovery/u;
test("an unbound closed draft needs operator recovery without moving code", async () => {
  const { job, cfg, state } = await closedDraft();
  try {
    assert.throws(() => issuePullRequest(cfg, ISSUE, state), NEEDS_RECOVERY);
    assert.throws(() => readWriteAuthority(cfg, ISSUE), NEEDS_RECOVERY);
    assert.throws(() => pushHead(cfg, ISSUE, "test"), NEEDS_RECOVERY);
    assert.equal(refOf(job.origin, BRANCH), "");
  } finally {
    job.close();
  }
});
