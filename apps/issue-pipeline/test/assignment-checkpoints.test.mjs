// @ts-check
// The same remote confirmation that gates assignment checkpoint state, using
// two isolated Git origins. Local commits do not become remote recovery claims.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  COMMIT_ENV,
  close,
  KEY,
  openFresh,
} from "./job-checkout-dropped-test-kit.mjs";
import { git, headOf, write } from "./pipeline-commit-test-kit.mjs";

const { assertPublishedHead } = await import("../src/assignment/checkpoint.ts");
const PUSH_ENV = Object.fromEntries([["ISSUE_PIPELINE_OPS", "1"]]);
const UNCONFIRMED = /not confirmed remotely/u;
const TEST_BOUND_MS = 20_000;

test("source and private wiki checkpoints require the exact published heads, never local-only commits", {
  timeout: TEST_BOUND_MS,
}, async () => {
  const job = openFresh();
  try {
    for (const [dir, tracked] of [
      [job.repo, "README.md"],
      [job.docs, "Home.md"],
    ]) {
      if (dir === undefined || tracked === undefined) {
        throw new Error("incomplete origin fixture");
      }
      const location = { dir, branch: job.branch };
      const original = headOf(dir);
      assert.throws(
        () => assertPublishedHead(job.cfg, location, original),
        UNCONFIRMED,
      );
      git(
        dir,
        ["push", "--quiet", "origin", `HEAD:refs/heads/${job.branch}`],
        PUSH_ENV,
      );
      assertPublishedHead(job.cfg, location, original);
      write(dir, tracked, "local-only recovery bytes\n");
      git(dir, ["commit", "-am", "Unpublished checkpoint"], COMMIT_ENV);
      const unpublished = headOf(dir);
      assert.notEqual(unpublished, original);
      assert.throws(
        () => assertPublishedHead(job.cfg, location, unpublished),
        UNCONFIRMED,
      );
      assert.equal(headOf(dir), unpublished);
      assert.equal(
        fs.readFileSync(`${dir}/${tracked}`, "utf8"),
        "local-only recovery bytes\n",
      );
      // A positive remote read of the old checkpoint is not permission to
      // claim that later local work was pushed after a lost response.
      assertPublishedHead(job.cfg, location, original);
      git(
        dir,
        ["push", "--quiet", "origin", `HEAD:refs/heads/${job.branch}`],
        PUSH_ENV,
      );
      assertPublishedHead(job.cfg, location, unpublished);
      assert.throws(
        () => assertPublishedHead(job.cfg, location, original),
        UNCONFIRMED,
      );
    }
  } finally {
    await close(job, KEY);
  }
});
