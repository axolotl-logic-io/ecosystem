// @ts-check
// What links a pipeline_commit to its session (Token-Spend): each commit's
// Pipeline-Session trailer, naming the session's launch key and the job's
// start, and the line pushes.jsonl in the issue's run folder gets per push,
// naming the session, the job's id, the repo and the commit. A scope without
// the job's start, from a job started before the trailer, still commits and
// pushes, without it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  git,
  headOf,
  JOB_ID,
  JOB_STARTED_AT,
  KEY,
  openJob,
  write,
} from "./pipeline-commit-test-kit.mjs";

test("each pushed commit carries the session's trailer, and pushes.jsonl gets a line per push naming the session and job", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "README.md", "changed\n");
    write(job.repo, "docs/Home.md", "changed\n");
    const result = await job.commit(["-am", "Add the page"]);
    assert.equal(result.isError, false);
    const trailer = `${KEY}@${JOB_STARTED_AT}`;
    const format = "--format=%(trailers:key=Pipeline-Session,valueonly)";
    assert.equal(git(job.repo, ["log", "-1", format]), trailer);
    const file = path.join(job.runDir, "pushes.jsonl");
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const facts = lines.map(({ key, job: id, repo, sha }) => ({
      key,
      id,
      repo,
      sha,
    }));
    assert.deepEqual(facts, [
      { key: KEY, id: JOB_ID, repo: "code", sha: headOf(job.repo) },
    ]);
    for (const { at } of lines) {
      assert.ok(Date.parse(at) > 0, at);
    }
  } finally {
    job.close();
  }
});

test("a scope without the job's start commits and pushes code and its docs with no trailer", async () => {
  const job = await openJob("implement", { withJobStart: false });
  try {
    write(job.repo, "README.md", "changed\n");
    write(job.repo, "docs/Home.md", "changed\n");
    const result = await job.commit(["-am", "Add the page"]);
    assert.equal(result.isError, false);
    assert.equal(result.details.pushed, "code");
    assert.equal(git(job.repo, ["log", "-1", "--format=%s"]), "Add the page");
    const format = "--format=%(trailers:key=Pipeline-Session,valueonly)";
    assert.equal(git(job.repo, ["log", "-1", format]), "");
  } finally {
    job.close();
  }
});
