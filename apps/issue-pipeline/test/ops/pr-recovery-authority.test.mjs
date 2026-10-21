// @ts-check
// Explicit reopen is recovery, not permission to push before validation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { refOf } from "../job-git-test-kit.mjs";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  openJob,
  write,
} from "../pipeline-commit-test-kit.mjs";
import {
  failPrReopen,
  saveAuthority,
  savePrAuthority,
  savePrHistory,
} from "../write-authority-test-kit.mjs";

const { newIssueState } = await import("../../src/state.ts");
const { withCheckout } = await import("../../src/config.ts");
const { prOps } = await import("../../src/ops/pr.ts");
const { readWriteState } = await import("../../src/saved-state.ts");
const PR = 42;
const ops = new Map(Object.entries(prOps));
const REFUSALS = {
  "no-explicit-reopen": /closed.*operator recovery/u,
  merged: /merged; refusing draft recovery/u,
  "wrong-base": /targets main/u,
  "wrong-branch": /is not from/u,
  ambiguous: /history is saturated or ambiguous/u,
  unreadable: /fake PR query failed/u,
  "failed-reopen": /fake reopen denied/u,
};

/** @param {import("../pipeline-commit-test-kit.mjs").Job} job */
function pendingWork(job) {
  const original = headOf(job.repo);
  write(job.repo, "README.md", "pending local C\n");
  git(job.repo, ["add", "README.md"]);
  git(
    job.repo,
    ["commit", "-m", "Pending work"],
    Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
  );
  const local = headOf(job.repo);
  return { original, local };
}

/** @param {import("../pipeline-commit-test-kit.mjs").Job} job @param {string} bad */
function recovery(job, bad) {
  const { original, local } = pendingWork(job);
  saveAuthority(job.cfg, {
    ...newIssueState(ISSUE),
    stage: "implement",
    branch: job.branch,
  });
  savePrHistory(job.cfg, [{ number: PR }]);
  const view = {
    number: PR,
    state: "CLOSED",
    headRefName: job.branch,
    headRefOid: original,
    baseRefName: job.cfg.baseBranch,
    isCrossRepository: false,
    mergeCommit: null,
  };
  if (bad === "merged") {
    Object.assign(view, { state: "MERGED", mergeCommit: { oid: original } });
  }
  if (bad === "wrong-base") {
    view.baseRefName = "main";
  }
  if (bad === "wrong-branch") {
    view.headRefName = "wrong";
  }
  if (bad === "ambiguous") {
    savePrHistory(job.cfg, [{ number: PR }, { number: PR + 1 }]);
  }
  savePrAuthority(job.cfg, view);
  if (bad === "unreadable") {
    savePrAuthority(job.cfg, null);
  }
  if (bad === "failed-reopen") {
    failPrReopen(job.cfg);
  }
  const cfg = withCheckout(job.cfg, {
    issue: ISSUE,
    dir: job.repo,
    branch: job.branch,
  });
  const request = { number: ISSUE, reopen: PR };
  if (bad === "no-explicit-reopen") {
    Object.assign(request, { reopen: null });
  }
  return { local, cfg, request };
}

for (const [bad, matcher] of Object.entries(REFUSALS)) {
  test(`draft recovery rejects ${bad} before any code push and preserves exact local commit`, async () => {
    const job = await openJob("implement");
    try {
      const { local, cfg, request } = recovery(job, bad);
      const open = ops.get("open-pr");
      assert.ok(open);
      assert.throws(() => open(cfg, request), matcher);
      assert.equal(refOf(job.origin, BRANCH), "");
      assert.equal(headOf(job.repo), local);
      assert.equal(
        git(job.repo, ["show", "HEAD:README.md"]),
        "pending local C",
      );
      assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
    } finally {
      job.close();
    }
  });
}

test("explicit recovery reopens the valid draft and pushes the pending local commit", async () => {
  const job = await openJob("implement");
  try {
    const { local, cfg, request } = recovery(job, "valid");
    const open = ops.get("open-pr");
    assert.ok(open);
    const reply = open(cfg, request);
    assert.equal(reply.pr, PR);
    assert.equal(refOf(job.origin, BRANCH), local);
    assert.equal(headOf(job.repo), local);
    assert.equal(readWriteState(job.cfg, ISSUE).pr, PR);
  } finally {
    job.close();
  }
});
