// @ts-check
// pipeline_commit end to end, in-process against bare remotes, through the
// jobs of pipeline-commit-test-kit.mjs (Pipeline-Job-Contract#reply-and-push).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { BASE, refOf } from "./job-git-test-kit.mjs";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  openJob,
  pushesOf,
  write,
} from "./pipeline-commit-test-kit.mjs";

const { closeJobCheckout } = await import("../src/job/checkout-close.ts");
const { lastPush } = await import("../src/checkouts.ts");
const { STAGE_WIKI_ACCESS } = await import("../src/job/roles.ts");

const PUSHED_BRANCH = "origin/agent/issue-7";
const REFUSED_PUSH = /code push failed/u;
const NOTHING_COMMITTED = /git exited 1: .*nothing/su;
const HOOK_REFUSES = /pipeline_commit/u;
const NO_COMMITTING_SESSION = /no session of this job that commits/u;
const MISSING_PATHSPEC = /pathspec 'missing\.txt' did not match/u;
const REFUSE_ALL = "#!/bin/sh\nexit 1\n";
const HOOK_MODE = 0o755;
// The key closeJobCheckout names the job's dropped patches by.
const JOB_KEY = "implement-1";
// A sequence editor that stops the rebase at once, as a stopped rebase would.
const BREAK_ENV = Object.fromEntries([
  ["GIT_SEQUENCE_EDITOR", "sh -c 'echo break > \"$1\"' --"],
]);
// The variable the checkouts' pre-commit hook lets a commit through with.
const COMMIT_PASS = Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]);

// Most tests that commit run the implement stage, whose implementor writes
// the code and its docs (`implementor-owns-the-change`).

test("code and a new docs page make one commit, and it is pushed", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "README.md", "changed\n");
    write(job.repo, "docs/Page.md", "new\n");
    // A new file is staged first, as a writer stages new code.
    git(job.repo, ["add", "docs/Page.md"]);
    const result = await job.commit([
      "-m",
      "Add the page",
      "--",
      "repo/README.md",
      "repo/docs/Page.md",
    ]);
    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(result.details.pushed, "code");
    assert.equal(result.details.pushError, null);
    assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
    assert.equal(git(job.repo, ["log", "-1", "--format=%s"]), "Add the page");
    assert.equal(
      git(job.repo, ["show", "--name-only", "--format=", "HEAD"]),
      "README.md\ndocs/Page.md",
    );
    assert.deepEqual(pushesOf(job), [{ repo: "code", sha: headOf(job.repo) }]);
    const record = { sha: headOf(job.repo), op: "pipeline-commit" };
    assert.deepEqual(lastPush(job.cfg, ISSUE), record);
  } finally {
    job.close();
  }
});

test("a docs-only change is a code commit, pushed like any other", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "docs/Page.md", "new\n");
    git(job.repo, ["add", "docs/Page.md"]);
    const result = await job.commit([
      "-m",
      "Docs page",
      "--",
      "repo/docs/Page.md",
    ]);
    assert.equal(result.details.pushed, "code");
    assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
  } finally {
    job.close();
  }
});

test("a git error in the code repo fails the call, and nothing is pushed", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "docs/Page.md", "new\n");
    const args = ["-m", "Both", "--", "repo/docs/Page.md", "repo/missing.txt"];
    const result = await job.commit(args);
    assert.equal(result.isError, true);
    assert.notEqual(result.details.code.exitCode, 0);
    assert.match(result.content[0].text, MISSING_PATHSPEC);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});

test("nothing to commit fails with git's exit code and pushes nothing", async () => {
  const job = await openJob("implement");
  try {
    const result = await job.commit(["-am", "Nothing"]);
    assert.equal(result.isError, true);
    assert.equal(result.details.code.exitCode, 1);
    assert.match(result.content[0].text, NOTHING_COMMITTED);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});

test("an implement job's commit whose push was refused is pushed as the job exits", async () => {
  const job = await openJob("implement");
  const hook = path.join(job.origin, "hooks", "pre-receive");
  try {
    fs.writeFileSync(hook, REFUSE_ALL, { mode: HOOK_MODE });
    write(job.repo, "docs/Home.md", "changed\n");
    const result = await job.commit(["-am", "Docs page"]);
    assert.equal(result.details.pushed, "none");
    assert.match(result.details.pushError, REFUSED_PUSH);
  } finally {
    job.close();
  }
  let exitPushes = 0;
  const { lost } = await closeJobCheckout(
    job.cfg,
    ISSUE,
    {
      root: job.root,
      repo: job.repo,
      docs: null,
      branch: job.branch,
      wiki: STAGE_WIKI_ACCESS.implement,
      key: JOB_KEY,
    },
    () => {
      exitPushes += 1;
      return Promise.resolve();
    },
  );
  assert.deepEqual(lost, []);
  assert.equal(exitPushes, 1);
});

test("a reader stage's docs edit is never pushed: teardown drops it as a patch", async () => {
  const job = await openJob("author");
  try {
    write(job.repo, "docs/Page.md", "new\n");
  } finally {
    job.close();
  }
  const { lost, patches } = await closeJobCheckout(
    job.cfg,
    ISSUE,
    {
      root: job.root,
      repo: job.repo,
      docs: null,
      branch: job.branch,
      wiki: STAGE_WIKI_ACCESS.author,
      key: JOB_KEY,
    },
    null,
  );
  assert.deepEqual(lost, ["repo/docs/Page.md"]);
  assert.deepEqual(patches, [`dropped/${JOB_KEY}-repo.patch`]);
  assert.equal(refOf(job.origin, BRANCH), "");
});

test("the job pushes nothing for a launch not given commit authority, so the commit stays local", async () => {
  const job = await openJob("review", { commits: false });
  try {
    write(job.repo, "README.md", "unauthorized\n");
    const result = await job.commit(["-am", "Unauthorized"]);
    assert.equal(result.details.pushed, "none");
    assert.match(result.details.pushError, NO_COMMITTING_SESSION);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});

test("a reviewer's hardening commit in a review job is pushed like the implementor's", async () => {
  const job = await openJob("review");
  try {
    write(job.repo, "README.md", "hardened\n");
    const result = await job.commit(["-am", "Harden"]);
    assert.equal(result.details.pushed, "code");
    assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
  } finally {
    job.close();
  }
});

test("a refused push keeps the commit and reports it, and the next call pushes both commits", async () => {
  const job = await openJob("implement");
  const hook = path.join(job.origin, "hooks", "pre-receive");
  try {
    fs.writeFileSync(hook, REFUSE_ALL, { mode: HOOK_MODE });
    write(job.repo, "README.md", "first\n");
    const first = await job.commit(["-am", "First"]);
    assert.equal(first.isError, false);
    assert.equal(first.details.pushed, "none");
    assert.match(first.details.pushError, REFUSED_PUSH);
    assert.equal(typeof first.details.code.sha, "string");
    assert.equal(refOf(job.origin, BRANCH), "");
    fs.rmSync(hook);
    write(job.repo, "README.md", "second\n");
    const second = await job.commit(["-am", "Second"]);
    assert.equal(second.details.pushed, "code");
    assert.equal(second.details.pushError, null);
    assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
    const below = ["log", "-1", "--format=%s", `${PUSHED_BRANCH}~1`];
    assert.equal(git(job.repo, below), "First");
  } finally {
    job.close();
  }
});

test("a commit during a stopped rebase is deferred and the remote is unchanged", async () => {
  const job = await openJob("implement");
  try {
    git(job.repo, ["rebase", "-i", `origin/${BASE}`], BREAK_ENV);
    write(job.repo, "README.md", "mid-rebase\n");
    const result = await job.commit(["-am", "Mid rebase"]);
    assert.equal(result.isError, false);
    assert.equal(result.details.pushed, "deferred");
    assert.equal(typeof result.details.code.sha, "string");
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});

test("a plain git commit is refused in the code checkout, and passes with ISSUE_PIPELINE_COMMIT=1", async () => {
  const job = await openJob("implement");
  try {
    const args = ["-C", job.repo, "commit", "--allow-empty", "-m", "Direct"];
    const refused = spawnSync("git", args, { encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, HOOK_REFUSES);
    const passed = spawnSync("git", args, {
      encoding: "utf8",
      env: { ...process.env, ...COMMIT_PASS },
    });
    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    job.close();
  }
});
