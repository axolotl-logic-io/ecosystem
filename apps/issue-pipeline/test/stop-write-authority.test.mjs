// @ts-check
// Real socket refusal followed by the real implement stop must never salvage
// forbidden code to a local bare origin. Recovery is checked independently.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
  authorityCalls,
  saveAuthority,
  savePrAuthority,
  savePrHistory,
} from "./write-authority-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");
const { withCheckout, paths } = await import("../src/config.ts");
const { stop } = await import("../src/ops/stop.ts");
const { closeJobCheckout } = await import("../src/job/checkout-close.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { ghIsRead } = await import("../src/github.ts");
const PR = 42;
const RECOVERY = "salvage-refused";

/** @param {import("./pipeline-commit-test-kit.mjs").Job} job @param {string} kind @param {boolean} deleted */
async function refusedWork(job, kind, deleted) {
  const original = headOf(job.repo);
  if (!deleted) {
    git(job.origin, ["update-ref", BRANCH, original]);
  }
  const receipt = { pr: PR, sha: original };
  const state = {
    ...newIssueState(ISSUE),
    stage: "implement",
    branch: job.branch,
  };
  if (kind === "saved") {
    state.codeMerged = receipt;
  } else if (kind === "own-merge") {
    state.merged = { code: original, wiki: null, inputs: "original" };
  } else {
    if (kind === "live") {
      state.pr = PR;
    }
    savePrHistory(job.cfg, [{ number: PR }]);
    savePrAuthority(job.cfg, {
      number: PR,
      state: "MERGED",
      headRefName: job.branch,
      headRefOid: original,
      baseRefName: job.cfg.baseBranch,
      isCrossRepository: false,
      mergeCommit: { oid: original },
    });
  }
  saveAuthority(job.cfg, state);
  write(job.repo, "README.md", "forbidden C\n");
  const reply = await job.commit(["-am", "Refused local C"]);
  const local = headOf(job.repo);
  write(job.repo, "dirty.txt", "exact dirty work\n");
  let remote = original;
  if (deleted) {
    remote = "";
  }
  return { state, original, local, remote, pushed: reply.details.pushed };
}

/** @param {import("./pipeline-commit-test-kit.mjs").Job} job @returns {Promise<string>} */
async function restoredWork(job) {
  await closeJobCheckout(job.cfg, ISSUE, { ...job, key: RECOVERY }, null);
  const bundle = path.join(
    paths.runDir(job.cfg, ISSUE),
    "recovery",
    `${RECOVERY}-code.bundle`,
  );
  const restored = path.join(path.dirname(job.origin), "restored");
  git(path.dirname(job.origin), ["clone", bundle, restored]);
  const patch = paths.droppedPatch(job.cfg, ISSUE, RECOVERY, "repo");
  git(restored, ["apply", patch]);
  return restored;
}

for (const kind of ["saved", "own-merge", "live", "unsaved-live"]) {
  for (const deleted of [false, true]) {
    test(`${kind} merge refuses socket and actual stop code salvage; deleted branch=${deleted}`, async () => {
      const job = await openJob("implement");
      try {
        const { state, original, local, remote, pushed } = await refusedWork(
          job,
          kind,
          deleted,
        );
        assert.equal(pushed, "none");
        assert.notEqual(local, original);
        const cfg = withCheckout(job.cfg, {
          issue: ISSUE,
          dir: job.repo,
          branch: job.branch,
        });
        const result = stop(cfg, {
          number: ISSUE,
          code: "not-doable",
          reason: "cannot",
          state: { ...state, pr: null, codeMerged: null, merged: null },
        });
        assert.equal(result.state.stage, "stopped");
        assert.equal(result.state.stoppedStage, "implement");
        assert.equal(result.state.lease, null);
        assert.deepEqual(result.state.codeMerged, state.codeMerged);
        assert.deepEqual(result.state.merged, state.merged);
        assert.equal(result.state.pr, state.pr);
        assert.equal(refOf(job.origin, BRANCH), remote);
        assert.equal(headOf(job.repo), local);
        assert.equal(
          fs.readFileSync(path.join(job.repo, "dirty.txt"), "utf8"),
          "exact dirty work\n",
        );
        const restored = await restoredWork(job);
        assert.equal(headOf(restored), local);
        assert.equal(
          fs.readFileSync(path.join(restored, "README.md"), "utf8"),
          "forbidden C\n",
        );
        assert.equal(refOf(job.origin, BRANCH), remote);
        assert.equal(
          fs.readFileSync(path.join(restored, "dirty.txt"), "utf8"),
          "exact dirty work\n",
        );
      } finally {
        job.close();
      }
    });
  }
}

for (const invalid of [null, { codeMerged: { pr: "broken" } }]) {
  test(`invalid stop authority refuses ALL mutation and retains exact checkout: ${JSON.stringify(invalid)}`, async () => {
    const job = await openJob("implement");
    try {
      const state = {
        ...newIssueState(ISSUE),
        stage: "implement",
        branch: job.branch,
      };
      let saved = null;
      if (invalid !== null) {
        saved = { ...state, ...invalid };
      }
      saveAuthority(job.cfg, saved);
      write(job.repo, "README.md", "held commit\n");
      await job.commit(["-am", "Held code"]);
      const local = headOf(job.repo);
      write(job.repo, "dirty.txt", "held dirty\n");
      const before = authorityCalls(job.cfg).filter((args) => !ghIsRead(args));
      const cfg = withCheckout(job.cfg, {
        issue: ISSUE,
        dir: job.repo,
        branch: job.branch,
      });
      assert.throws(() =>
        stop(cfg, { number: ISSUE, state, reason: "cannot" }),
      );
      assert.deepEqual(
        authorityCalls(job.cfg).filter((args) => !ghIsRead(args)),
        before,
      );
      assert.equal(refOf(job.origin, BRANCH), "");
      assert.equal(headOf(job.repo), local);
      assert.equal(
        fs.readFileSync(path.join(job.repo, "dirty.txt"), "utf8"),
        "held dirty\n",
      );
      assert.throws(() =>
        openJobCheckout(job.cfg, ISSUE, {
          stage: "implement",
          branch: job.branch,
        }),
      );
      assert.equal(headOf(job.repo), local);
    } finally {
      job.close();
    }
  });
}

test("a forged stop cannot clear PR/merge/security/input provenance or turn a genuine review stop into salvage", async () => {
  const job = await openJob("implement");
  try {
    const revision = { code: headOf(job.repo), wiki: null, inputs: "trusted" };
    const state = {
      ...newIssueState(ISSUE),
      stage: "review",
      branch: job.branch,
      pr: PR,
      hardened: revision,
      integration: { reviewed: revision, revision },
      security: {
        revision,
        commentId: 9,
        finding: { category: "rights", reason: "rejected" },
      },
      gherkin: { commentId: 8, rev: 1, inputs: "trusted" },
    };
    saveAuthority(job.cfg, state);
    // Code can exist locally even when its control socket cannot publish it.
    write(job.repo, "README.md", "held review code\n");
    git(job.repo, ["add", "README.md"]);
    git(
      job.repo,
      ["commit", "-m", "Held review code"],
      Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
    );
    const local = headOf(job.repo);
    const cfg = withCheckout(job.cfg, {
      issue: ISSUE,
      dir: job.repo,
      branch: job.branch,
    });
    const result = stop(cfg, {
      number: ISSUE,
      reason: "forged implement",
      state: { ...newIssueState(ISSUE), stage: "implement" },
    });
    assert.equal(result.state.stoppedStage, "review");
    assert.deepEqual(result.state.hardened, state.hardened);
    assert.deepEqual(result.state.integration, state.integration);
    assert.deepEqual(result.state.security, state.security);
    assert.deepEqual(result.state.gherkin, state.gherkin);
    assert.equal(result.state.pr, PR);
    assert.equal(result.state.branch, job.branch);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.equal(headOf(job.repo), local);
  } finally {
    job.close();
  }
});
