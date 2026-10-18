// @ts-check
// A closed draft may disappear only from proven wiki-only READ authority.
import assert from "node:assert/strict";
import { test } from "node:test";
import { refOf } from "./job-git-test-kit.mjs";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  openJob,
  write,
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
const { readWriteState } = await import("../src/saved-state.ts");
const { pushBranch } = await import("../src/ops/sync-finish.ts");
const { syncOps } = await import("../src/ops/sync.ts");
const { prOps } = await import("../src/ops/pr.ts");
const { pushOps } = await import("../src/ops/push.ts");
const PR = 42;

/** @param {import("./pipeline-commit-test-kit.mjs").Job} job @param {import("../src/state.ts").IssueState} state @param {{baseRefName: string, headRefName: string, isCrossRepository: boolean}} view @param {string} bad @returns {void} */
function invalidateDraft(job, state, view, bad) {
  if (bad === "non-done") {
    state.stage = "review";
  }
  if (bad === "head-mismatch") {
    state.headSha = "stale-head";
  }
  if (bad === "missing-receipt") {
    state.merged = null;
  }
  if (bad === "code-flow") {
    state.flows = { code: true, wiki: true };
  }
  if (bad === "dirty-code") {
    write(job.repo, "README.md", "local edits\n");
  }
  if (bad === "local-commit") {
    git(
      job.repo,
      ["commit", "--allow-empty", "-m", "Unconfirmed C"],
      Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
    );
  }
  if (bad === "wrong-base") {
    view.baseRefName = "main";
  }
  if (bad === "wrong-branch") {
    view.headRefName = "stale-branch";
  }
  if (bad === "wrong-repo") {
    view.isCrossRepository = true;
  }
  if (bad === "malformed-receipt") {
    saveAuthority(job.cfg, { ...state, merged: {} });
  } else {
    saveAuthority(job.cfg, state);
  }
}

/** @param {string} bad */
async function closedDraft(bad) {
  const job = await openJob("implement");
  const base = headOf(job.repo);
  git(
    job.repo,
    ["commit", "--allow-empty", "-m", "Actual closed draft head"],
    Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
  );
  const original = headOf(job.repo);
  git(job.repo, ["reset", "--hard", base]);
  const revision = { code: null, wiki: "checked-wiki", inputs: "trusted" };
  /** @type {import("../src/state.ts").IssueState} */
  const state = {
    ...newIssueState(ISSUE),
    stage: "done",
    branch: job.branch,
    headSha: original,
    flows: { code: false, wiki: true },
    merged: revision,
    hardened: { ...revision, code: original },
    security: { revision, commentId: 9, finding: null },
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
  invalidateDraft(job, state, view, bad);
  savePrHistory(job.cfg, [{ number: PR }]);
  savePrAuthority(job.cfg, view);
  const cfg = withCheckout(job.cfg, {
    issue: ISSUE,
    branch: job.branch,
    dir: job.repo,
  });
  return { job, cfg, state };
}

test("done wiki-only replay can read clean base after branch deletion but grants no code push authority", async () => {
  const { job, cfg, state } = await closedDraft("valid");
  try {
    assert.equal(issuePullRequest(cfg, ISSUE, state), null);
    assert.equal(readWriteAuthority(cfg, ISSUE).codeWritable, false);
    assert.throws(() => pushHead(cfg, ISSUE, "test"));
    assert.throws(() => pushBranch(cfg, ISSUE, job.repo, "test"));
    /** @type {Iterable<readonly [string, (config: import("../src/config.ts").Config, request: unknown) => unknown]>} */
    const entries = [
      ...Object.entries(syncOps),
      ...Object.entries(prOps),
      ...Object.entries(pushOps),
    ];
    const writes = new Map(entries);
    for (const name of [
      "sync-base",
      "finish-sync",
      "start-pr",
      "open-pr",
      "push",
      "exit-push",
    ]) {
      const mutate = writes.get(name);
      assert.ok(mutate);
      assert.throws(() => mutate(cfg, { number: ISSUE }));
    }
    assert.deepEqual(readWriteState(cfg, ISSUE), state);
    assert.equal(refOf(job.origin, BRANCH), "");
  } finally {
    job.close();
  }
});

for (const bad of [
  "non-done",
  "head-mismatch",
  "missing-receipt",
  "malformed-receipt",
  "code-flow",
  "dirty-code",
  "local-commit",
  "wrong-base",
  "wrong-branch",
  "wrong-repo",
]) {
  test(`closed wiki-only history refuses ${bad} without changing code ref`, async () => {
    const { job, cfg, state } = await closedDraft(bad);
    try {
      assert.throws(() => issuePullRequest(cfg, ISSUE, state));
      assert.throws(() => readWriteAuthority(cfg, ISSUE));
      assert.throws(() => pushHead(cfg, ISSUE, "test"));
      assert.equal(refOf(job.origin, BRANCH), "");
    } finally {
      job.close();
    }
  });
}

test("non-done genuine wiki-only work retains its original closed PR head and never gains code authority", async () => {
  const { job, cfg, state } = await closedDraft("valid");
  try {
    assert.ok(state.headSha);
    git(job.repo, ["reset", "--hard", state.headSha]);
    const saved = { ...state, stage: "review" };
    saveAuthority(job.cfg, saved);
    assert.equal(issuePullRequest(cfg, ISSUE, saved), null);
    assert.equal(readWriteAuthority(cfg, ISSUE).codeWritable, false);
    assert.deepEqual(readWriteState(cfg, ISSUE), saved);
    assert.equal(headOf(job.repo), state.headSha);
    assert.equal(refOf(job.origin, BRANCH), "");
  } finally {
    job.close();
  }
});
