// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pageTextOf } from "../prompt-test-kit.mjs";
import {
  appendedOf,
  COMMIT_SCOPE_ENV,
  developerSpec,
  openMergeJob,
  piStarts,
  reviewerSpec,
  stateOf,
  toolsOf,
} from "./job-session-authority-test-kit.mjs";

const WRITES = ["bash", "edit", "write", "pipeline_commit"];
const REFUSED_PHASE = /security-review session can't set commits true/u;
const NO_PROMPT = /pinned no prompt for this merge session/u;
const SECURITY_PAGE = "security.md";

test("a Sync task job's resolver session commits as the Developer, and the merge job's security review only reads", async () => {
  const sync = await openMergeJob(undefined, { task: "sync" });
  /** @type {any[]} */
  let syncLaunches = [];
  try {
    const resolver = await sync.session(developerSpec(true, "sync"));
    assert.equal(resolver.ok, true);
    syncLaunches = JSON.parse(
      fs.readFileSync(path.join(sync.runDir, "job.json"), "utf8"),
    ).launches;
    assert.deepEqual(sync.appended.map(stateOf), ["sync"]);
  } finally {
    sync.control.close();
  }
  const job = await openMergeJob();
  try {
    const review = await job.session(reviewerSpec(false, "security-review"));
    assert.equal(review.ok, true);
    const [writer, reader] = piStarts().slice(-2);
    for (const tool of WRITES) {
      assert.ok(toolsOf(writer.argv).includes(tool), tool);
      assert.equal(toolsOf(reader.argv).includes(tool), false, tool);
    }
    assert.ok(writer.env.includes(COMMIT_SCOPE_ENV));
    assert.deepEqual(writer.commitScope.repo, { dir: "repo", access: "write" });
    assert.equal(reader.env.includes(COMMIT_SCOPE_ENV), false);
    assert.equal(reader.commitScope, null);
    for (const start of [writer, reader]) {
      assert.equal(start.ghToken, null);
      assert.equal(start.env.includes("GITHUB_TOKEN"), false);
    }
    const status = JSON.parse(
      fs.readFileSync(path.join(job.runDir, "job.json"), "utf8"),
    );
    const launches = [...syncLaunches, ...status.launches].map(
      (/** @type {any} */ launch) => [launch.key, launch.commits, launch.phase],
    );
    assert.deepEqual(launches, [
      ["implementor-sync-1", true, "sync"],
      ["reviewer-1", false, "security-review"],
    ]);
    assert.deepEqual(job.appended.map(stateOf), ["security-review"]);
    // The merge job runs no committing session at all.
    const writer2 = await job.session(reviewerSpec(true, "sync"));
    assert.equal(writer2.ok, false);
  } finally {
    job.control.close();
  }
});

test("a session whose authority its phase or stage forbids, or that the job pinned no prompt for, is refused before pi starts", async () => {
  const job = await openMergeJob();
  const before = piStarts().length;
  try {
    const result = await job.session(reviewerSpec(true, "security-review"));
    assert.ok(!result.ok);
    assert.match(result.error, REFUSED_PHASE);
    const other = await job.session({
      ...reviewerSpec(false),
      agent: "issue-pipeline-author",
    });
    assert.equal(other.ok, false);
    const unpinned = await openMergeJob("author");
    const unprompted = await unpinned.session(
      reviewerSpec(false, "security-review"),
    );
    unpinned.control.close();
    assert.ok(!unprompted.ok);
    assert.match(unprompted.error, NO_PROMPT);
    assert.equal(piStarts().length, before);
  } finally {
    job.control.close();
  }
});

test("each session's pi gets its phase's page appended to its system prompt as pinned, though the page changed after", async () => {
  const job = await openMergeJob();
  const before = piStarts().length;
  fs.writeFileSync(path.join(job.promptsDir, SECURITY_PAGE), "Edited.\n");
  try {
    await job.session(reviewerSpec(false, "security-review"));
    const starts = piStarts().slice(before);
    assert.deepEqual(
      starts.map(({ argv }) => appendedOf(argv)),
      [[pageTextOf(SECURITY_PAGE)]],
    );
    const status = JSON.parse(
      fs.readFileSync(path.join(job.runDir, "job.json"), "utf8"),
    );
    /** @type {{ page: string, sha256: string }[]} */
    const pages = status.prompts.map((/** @type {any} */ { page, sha256 }) => ({
      page,
      sha256,
    }));
    assert.deepEqual(
      pages.map(({ page }) => page),
      [SECURITY_PAGE],
    );
    const launched = status.launches.slice(-1);
    assert.deepEqual(
      launched.map((/** @type {any} */ l) => l.prompt),
      pages,
    );
    const used = job.appended.flatMap((entry) => {
      if (entry.kind === "session") {
        return [entry.prompt.sha256];
      }
      return [];
    });
    assert.deepEqual(
      used,
      pages.map(({ sha256 }) => sha256),
    );
  } finally {
    job.control.close();
  }
});
