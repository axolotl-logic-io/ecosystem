// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { saveAuthority } from "../write-authority-test-kit.mjs";
import {
  ISSUE,
  openMergeJob,
  piStarts,
  reviewerSpec,
  STAGE,
} from "./job-session-authority-test-kit.mjs";

const { newIssueState } = await import("../../src/state.ts");
const NO_AUTHORITY = /no saved write authority/u;

test("a writer session after the code merged binds read-only code and may commit nothing; security stays read-only and token-free", async () => {
  const job = await openMergeJob(STAGE, { merged: true });
  const before = piStarts().length;
  try {
    assert.equal(
      (await job.session(reviewerSpec(true, "integration"))).ok,
      true,
    );
    assert.equal(
      (await job.session(reviewerSpec(false, "security-review"))).ok,
      true,
    );
    const [writer, reader] = piStarts().slice(before);
    assert.deepEqual(writer.commitScope.repo, { dir: "repo", access: "read" });
    assert.deepEqual(writer.commitScope.allowed, []);
    assert.equal(reader.commitScope, null);
    assert.equal(writer.ghToken, null);
    assert.equal(reader.ghToken, null);
    const status = JSON.parse(
      fs.readFileSync(path.join(job.runDir, "job.json"), "utf8"),
    );
    assert.deepEqual(status.launches[0].scope, {
      repo: { dir: "repo", access: "read" },
      allowed: [],
    });
    assert.equal(status.launches[1].scope, null);
  } finally {
    job.control.close();
  }
});

test("each launch reads saved authority again, and missing authority refuses before pi starts", async () => {
  const job = await openMergeJob();
  const before = piStarts().length;
  try {
    assert.equal(
      (await job.session(reviewerSpec(true, "integration"))).ok,
      true,
    );
    saveAuthority(job.cfg, {
      ...newIssueState(ISSUE),
      stage: STAGE,
      branch: "agent/issue-7",
      codeMerged: { pr: 42, sha: "merged-code" },
    });
    assert.equal(
      (await job.session(reviewerSpec(true, "integration"))).ok,
      true,
    );
    const [first, second] = piStarts().slice(before);
    assert.equal(first.commitScope.repo.access, "write");
    assert.equal(second.commitScope.repo.access, "read");
    saveAuthority(job.cfg, null);
    await assert.rejects(
      job.session(reviewerSpec(true, "integration")),
      NO_AUTHORITY,
    );
    assert.equal(piStarts().length, before + 2);
  } finally {
    job.control.close();
  }
});
