// @ts-check
// An actual GitHub merge closes the interval before its receipt is saved.
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
import { saveAuthority, savePrAuthority } from "./write-authority-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");
const { ensureClone } = await import("../src/checkouts.ts");
const { withCheckout } = await import("../src/config.ts");
const { pushOps } = await import("../src/ops/push.ts");
const REFUSED = /code.*(?:merged|read.only)/u;
const PR = 42;

/** @param {import("./pipeline-commit-test-kit.mjs").Job} job @param {string} state */
function savedPr(job, state) {
  saveAuthority(job.cfg, {
    ...newIssueState(ISSUE),
    stage: "implement",
    branch: job.branch,
    pr: PR,
  });
  savePrAuthority(job.cfg, {
    number: PR,
    state,
    headRefName: job.branch,
    headRefOid: headOf(job.repo),
    baseRefName: job.cfg.baseBranch,
    isCrossRepository: false,
    mergeCommit: { oid: headOf(job.repo) },
  });
}

test("an OPEN PR permits ordinary premerge code pushes", async () => {
  const job = await openJob("implement");
  try {
    savedPr(job, "OPEN");
    write(job.repo, "README.md", "permitted\n");
    const reply = await job.commit(["-am", "Premerge work"]);
    assert.equal(reply.details.pushed, "code");
    assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
  } finally {
    job.close();
  }
});

test("GitHub MERGED with both saved receipts null refuses code, preserves it locally and still pushes wiki", async () => {
  const job = await openJob("implement");
  try {
    const original = headOf(job.repo);
    git(job.origin, ["update-ref", BRANCH, original]);
    savedPr(job, "MERGED");
    write(job.repo, "README.md", "too late\n");
    write(job.docs, "Page.md", "wiki followup\n");
    const reply = await job.commit(["-am", "After actual merge"]);
    assert.equal(reply.details.pushed, "wiki");
    assert.match(reply.details.pushError, REFUSED);
    assert.equal(refOf(job.origin, BRANCH), original);
    assert.notEqual(headOf(job.repo), original);
    assert.equal(refOf(job.wikiOrigin, BRANCH), headOf(job.docs));
    // Deterministic pushes share the same live authority guard.
    ensureClone(job.cfg);
    const cfg = withCheckout(job.cfg, {
      issue: ISSUE,
      dir: job.repo,
      branch: job.branch,
    });
    const { push, "exit-push": exitPush } = pushOps;
    assert.ok(push && exitPush);
    assert.throws(() => push(cfg, { number: ISSUE, codeMerged: null }));
    assert.throws(() => exitPush(cfg, { number: ISSUE }));
    assert.equal(refOf(job.origin, BRANCH), original);
  } finally {
    job.close();
  }
});

test("deterministic wiki-only push remains available after an actual merge with no saved receipt", async () => {
  const job = await openJob("implement");
  try {
    const original = headOf(job.repo);
    git(job.origin, ["update-ref", BRANCH, original]);
    savedPr(job, "MERGED");
    write(job.docs, "Page.md", "wiki only\n");
    const reply = await job.commit([
      "-m",
      "Wiki followup",
      "--",
      "docs/Page.md",
    ]);
    assert.equal(reply.details.pushed, "wiki");
    ensureClone(job.cfg);
    const cfg = withCheckout(job.cfg, {
      issue: ISSUE,
      dir: job.repo,
      branch: job.branch,
    });
    const { push } = pushOps;
    assert.ok(push);
    const result = push(cfg, { number: ISSUE, wikiOnly: true });
    assert.equal(result.headSha, original);
    assert.equal(refOf(job.origin, BRANCH), original);
  } finally {
    job.close();
  }
});

for (const state of ["CLOSED", "query-failure", "wrong-branch"]) {
  test(`a ${state} PR cannot authorize code or wiki mutation`, async () => {
    const job = await openJob("implement");
    try {
      savedPr(job, state);
      if (state === "query-failure") {
        savePrAuthority(job.cfg, null);
      }
      if (state === "wrong-branch") {
        savePrAuthority(job.cfg, {
          number: PR,
          state: "OPEN",
          headRefName: "wrong",
          headRefOid: "head",
          baseRefName: job.cfg.baseBranch,
          isCrossRepository: false,
        });
      }
      write(job.repo, "README.md", "unconfirmed code\n");
      write(job.docs, "Page.md", "unconfirmed wiki\n");
      const reply = await job.commit(["-am", "Unconfirmed work"]);
      assert.equal(reply.details.pushed, "none");
      assert.equal(typeof reply.details.pushError, "string");
      assert.equal(refOf(job.origin, BRANCH), "");
      assert.equal(refOf(job.wikiOrigin, BRANCH), "");
      ensureClone(job.cfg);
      const cfg = withCheckout(job.cfg, {
        issue: ISSUE,
        dir: job.repo,
        branch: job.branch,
      });
      const { push, "exit-push": exitPush } = pushOps;
      assert.ok(push && exitPush);
      assert.throws(() => push(cfg, { number: ISSUE }));
      assert.throws(() => exitPush(cfg, { number: ISSUE }));
      assert.equal(refOf(job.origin, BRANCH), "");
    } finally {
      job.close();
    }
  });
}
