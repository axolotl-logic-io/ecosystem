// A closed draft the saved state does not name grants no authority: every
// history of one needs operator recovery, and no code ref changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { IssueState } from "../src/state.ts";
import { refOf } from "./job-git-test-kit.ts";
import type { Job } from "./pipeline-commit-test-kit.ts";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  openJob,
} from "./pipeline-commit-test-kit.ts";
import {
  saveAuthority,
  savePrAuthority,
  savePrHistory,
} from "./write-authority-test-kit.ts";

const { newIssueState }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const { withCheckout }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { issuePullRequest }: typeof import("../src/revision.ts") = await import(
  "../src/revision.ts"
);
const { readWriteAuthority }: typeof import("../src/write-authority.ts") =
  await import("../src/write-authority.ts");
const { pushHead }: typeof import("../src/checkouts.ts") = await import(
  "../src/checkouts.ts"
);
const PR = 42;

async function closedDraft(): Promise<{
  job: Job;
  cfg: Config;
  state: IssueState;
}> {
  const job = await openJob("implement");
  const base = headOf(job.repo);
  git(
    job.repo,
    ["commit", "--allow-empty", "-m", "Actual closed draft head"],
    Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
  );
  const original = headOf(job.repo);
  git(job.repo, ["reset", "--hard", base]);
  const state: IssueState = {
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
