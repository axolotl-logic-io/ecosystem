// Completion in the source's own modules, against real git and the fake gh:
// removeWorktree never removes a live stage job's own checkout
// (src/checkouts.ts), and the release op keeps a partial merge receipt and
// the saved code merge (src/ops/save-state.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { IssueState } from "../src/state.ts";
import { commentLines, githubComment } from "./fake-gh.ts";
import { isolatedOpsFixture } from "./integration-source-test-kit.ts";
import type { OpsFixture } from "./ops-fixtures.ts";

const fx: OpsFixture = await isolatedOpsFixture(
  "integration-source-completion",
);
fx.fakeGh.requireReplies();
const { fakeGh, sh, worktree }: OpsFixture = fx;
const { loadConfig, paths }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { removeWorktree }: typeof import("../src/checkouts.ts") = await import(
  "../src/checkouts.ts"
);
const { newIssueState }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const { parseStateBody, stateBody }: typeof import("../src/saved-state.ts") =
  await import("../src/saved-state.ts");

const cfg = loadConfig(path.join(fx.root, "config.json"));
const ISSUE = { job: 41, other: 42, released: 43, done: 44 };
const SHA_LENGTH = 40;
// The fake state comments' ids: this plus the issue's number.
const COMMENT_ID_BASE = 500;
const MERGE_COMMIT = "c".repeat(SHA_LENGTH);
const RECEIPT: { code: string; wiki: string; inputs: string } = {
  code: MERGE_COMMIT,
  wiki: "d".repeat(SHA_LENGTH),
  inputs: "inputs-1",
};
const CODE_MERGED: { pr: number; sha: string } = { pr: 9, sha: MERGE_COMMIT };
const OLD_LEASE = {
  lane: "orchestrator",
  sweepId: "s1",
  at: "2026-10-18T00:00:00.000Z",
};
const RELEASE_PATCH = /^body=/u;

function cloneHasBranch(branch: string): boolean {
  const clone = paths.clone(cfg);
  return sh(`git -C ${clone} branch --list ${branch}`) !== "";
}

test("removeWorktree leaves a live stage job's own checkout and removes the issue's worktree otherwise", () => {
  fx.startBranch(ISSUE.job, "j.txt", "job");
  // The job's checkout is a worktree of the pipeline's clone here, so that
  // only the guard, not git, keeps a removal from taking it.
  const jobDir = path.join(fx.root, "job-checkout");
  sh(
    `git -C ${paths.clone(cfg)} worktree add -q --detach ${jobDir} agent/issue-${ISSUE.job}`,
  );
  removeWorktree(
    {
      ...cfg,
      checkout: {
        issue: ISSUE.job,
        dir: jobDir,
        branch: `agent/issue-${ISSUE.job}`,
      },
    },
    ISSUE.job,
  );
  assert.ok(fs.existsSync(path.join(jobDir, ".git")), "the job's checkout");
  assert.ok(fs.existsSync(worktree(ISSUE.job)), "the issue's worktree");
  assert.ok(cloneHasBranch(`agent/issue-${ISSUE.job}`));
  // A job's checkout of another issue guards nothing here.
  removeWorktree(
    {
      ...cfg,
      checkout: {
        issue: ISSUE.other,
        dir: jobDir,
        branch: `agent/issue-${ISSUE.other}`,
      },
    },
    ISSUE.job,
  );
  assert.equal(fs.existsSync(worktree(ISSUE.job)), false);
  assert.equal(cloneHasBranch(`agent/issue-${ISSUE.job}`), false);
  assert.ok(fs.existsSync(path.join(jobDir, ".git")));
});

// The fake gh answers issue `n`'s comments with the pipeline's state comment
// holding `saved`; the release then reads it and patches it.
function savedStateComment(n: number, saved: IssueState): void {
  const comment = githubComment({
    id: COMMENT_ID_BASE + n,
    body: stateBody(n, saved),
    login: cfg.mergeAccount,
    created: "2026-10-17T00:00:00Z",
  });
  fakeGh.reply([
    {
      when: `issues/${n}/comments?per_page`,
      stdout: commentLines([comment]),
      keep: true,
      persistState: true,
    },
    {
      when: `api -X PATCH repos/${cfg.repo}/issues/comments/${COMMENT_ID_BASE + n} -f`,
      stdout: "",
    },
  ]);
}

// The states the release op patched into issue `n`'s state comment.
function patchedStates(n: number): Array<IssueState | null> {
  const patches = fakeGh
    .calls()
    .filter(
      (args) =>
        args.includes("PATCH") &&
        args.join(" ").includes(`comments/${COMMENT_ID_BASE + n}`),
    );
  return patches.map((args) => {
    const body = args.find((arg) => RELEASE_PATCH.test(arg)) ?? "";
    return parseStateBody(body.replace(RELEASE_PATCH, ""), n);
  });
}

function releaseOf(
  n: number,
  state: IssueState,
): { [x: string]: unknown; ok: true } {
  return z.looseObject({ ok: z.literal(true) }).parse(
    JSON.parse(
      fx.ask({
        op: "release",
        number: n,
        lane: "orchestrator",
        sweepId: "s1",
        state,
      }),
    ),
  );
}

test("a release keeps a partial merge receipt and the saved code merge, and renews the lease", () => {
  const n = ISSUE.released;
  savedStateComment(n, {
    ...newIssueState(n),
    stage: "merge",
    codeMerged: CODE_MERGED,
  });
  // The merge job's legacy state after the code merged, before completion:
  // the role never carries the code merge itself.
  const ending = {
    ...newIssueState(n),
    stage: "merge" as const,
    pr: CODE_MERGED.pr,
    merged: RECEIPT,
    codeMerged: null,
    lease: OLD_LEASE,
  };
  releaseOf(n, ending);
  const [written, ...more] = patchedStates(n);
  assert.deepEqual(more, []);
  assert.deepEqual(written?.merged, RECEIPT);
  assert.deepEqual(written?.codeMerged, CODE_MERGED);
  assert.equal(written?.stage, "merge");
  assert.equal(written?.lease?.lane, OLD_LEASE.lane);
  assert.ok(Date.parse(written?.lease?.at ?? "") > Date.parse(OLD_LEASE.at));
});

test("a release of a done completion keeps what merged and the code merge", () => {
  const n = ISSUE.done;
  savedStateComment(n, {
    ...newIssueState(n),
    stage: "merge",
    codeMerged: CODE_MERGED,
  });
  const done = {
    ...newIssueState(n),
    stage: "done" as const,
    merged: RECEIPT,
    codeMerged: CODE_MERGED,
  };
  releaseOf(n, done);
  const [written, ...more] = patchedStates(n);
  assert.deepEqual(more, []);
  assert.equal(written?.stage, "done");
  assert.deepEqual(written?.merged, RECEIPT);
  assert.deepEqual(written?.codeMerged, CODE_MERGED);
  assert.equal(written?.lease, null);
});
