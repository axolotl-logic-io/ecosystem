// @ts-check
// pipeline_commit end to end, in-process against bare remotes, through the
// jobs of pipeline-commit-test-kit.mjs (Pipeline-Roles-Shared,
// "pipeline_commit").
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

const { closeJobCheckout } = await import("../src/job/checkout.ts");
const { lastPush } = await import("../src/checkouts.ts");
const { STAGE_WIKI_ACCESS } = await import("../src/job/roles.ts");

/** @import { StageName } from "../src/workflow/stages/types.ts" */

const PUSHED_BRANCH = "origin/agent/issue-7";
const REFUSED_PUSH = /code push failed/u;
const REFUSED_WIKI_PUSH = /wiki push failed/u;
const NOTHING_COMMITTED = /git exited 1: .*nothing/su;
const HOOK_REFUSES = /pipeline_commit/u;
const MISSING_PATHSPEC = /pathspec 'missing\.txt' did not match/u;
// A stage that defers every push, with a file its job may commit, relative
// to the job's folder: sync writes code, merge and publish (mergers) write
// only the wiki.
/** @type {[StageName, string][]} */
const DEFERRED_COMMITS = [
  ["sync", "repo/README.md"],
  ["merge", "docs/Home.md"],
  ["publish", "docs/Home.md"],
];
const REFUSE_ALL = "#!/bin/sh\nexit 1\n";
const HOOK_MODE = 0o755;
// A sequence editor that stops the rebase at once, as a stopped rebase would.
const BREAK_ENV = Object.fromEntries([
  ["GIT_SEQUENCE_EDITOR", "sh -c 'echo break > \"$1\"' --"],
]);
// The variable the checkouts' pre-commit hook lets a commit through with.
const COMMIT_PASS = Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]);

test("code and a new wiki page make two commits with one message, and both are pushed", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "README.md", "changed\n");
    write(job.docs, "Page.md", "new\n");
    const result = await job.commit(["-am", "Add the page"]);
    assert.equal(result.isError, false);
    assert.equal(result.details.pushed, "both");
    assert.equal(result.details.pushError, null);
    assert.equal(refOf(job.origin, BRANCH), headOf(job.repo));
    assert.equal(refOf(job.wikiOrigin, BRANCH), headOf(job.docs));
    for (const dir of [job.repo, job.docs]) {
      assert.equal(git(dir, ["log", "-1", "--format=%s"]), "Add the page");
    }
    assert.deepEqual(pushesOf(job), [
      { repo: "code", sha: headOf(job.repo) },
      { repo: "wiki", sha: headOf(job.docs) },
    ]);
    const record = { sha: headOf(job.repo), op: "pipeline-commit" };
    assert.deepEqual(lastPush(job.cfg, ISSUE), record);
  } finally {
    job.close();
  }
});

test("a wiki-only change pushes only the wiki", async () => {
  const job = await openJob("implement");
  try {
    write(job.docs, "Page.md", "new\n");
    const result = await job.commit(["-m", "Wiki page", "--", "docs/Page.md"]);
    assert.equal(result.details.pushed, "wiki");
    assert.equal(result.details.code, null);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.equal(refOf(job.wikiOrigin, BRANCH), headOf(job.docs));
  } finally {
    job.close();
  }
});

test("a wiki-only change with no pathspec commits and pushes the wiki though the code repo had nothing to commit", async () => {
  const job = await openJob("implement");
  try {
    write(job.docs, "Page.md", "new\n");
    const result = await job.commit(["-am", "Wiki page"]);
    assert.equal(result.isError, false);
    assert.equal(result.details.pushed, "wiki");
    assert.equal(result.details.code.sha, null);
    assert.notEqual(result.details.code.exitCode, 0);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.equal(refOf(job.wikiOrigin, BRANCH), headOf(job.docs));
    assert.deepEqual(pushesOf(job), [{ repo: "wiki", sha: headOf(job.docs) }]);
  } finally {
    job.close();
  }
});

test("a git error in the code repo fails the call, and neither repo is pushed though the wiki committed", async () => {
  const job = await openJob("implement");
  try {
    write(job.docs, "Page.md", "new\n");
    const args = ["-m", "Both", "--", "docs/Page.md", "repo/missing.txt"];
    const result = await job.commit(args);
    assert.equal(result.isError, true);
    assert.notEqual(result.details.code.exitCode, 0);
    assert.equal(typeof result.details.wiki.sha, "string");
    assert.match(result.content[0].text, MISSING_PATHSPEC);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.equal(refOf(job.wikiOrigin, BRANCH), "");
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

test("an implement job's writer commits a wiki page with pipeline_commit, and it is pushed, until the spec writer makes the wiki updates", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "README.md", "changed\n");
    write(job.docs, "Page.md", "new\n");
    const result = await job.commit(["-am", "Code and its wiki page"]);
    assert.equal(result.isError, false);
    assert.equal(result.details.pushed, "both");
    assert.equal(refOf(job.wikiOrigin, BRANCH), headOf(job.docs));
    const files = ["show", "--name-only", "--format=", "HEAD"];
    assert.equal(git(job.docs, files), "Page.md");
  } finally {
    job.close();
  }
});

test("an implement job's wiki commit whose push was refused is pushed as the job exits", async () => {
  const job = await openJob("implement");
  const hook = path.join(job.wikiOrigin, "hooks", "pre-receive");
  try {
    fs.writeFileSync(hook, REFUSE_ALL, { mode: HOOK_MODE });
    write(job.docs, "Page.md", "new\n");
    const result = await job.commit(["-m", "Wiki page", "--", "docs/Page.md"]);
    assert.equal(result.details.pushed, "none");
    assert.match(result.details.pushError, REFUSED_WIKI_PUSH);
  } finally {
    job.close();
  }
  let exitPushes = 0;
  const access = STAGE_WIKI_ACCESS.implement;
  const lost = await closeJobCheckout(
    job.cfg,
    ISSUE,
    { root: job.root, repo: job.repo, docs: job.docs, wiki: access },
    () => {
      exitPushes += 1;
      return Promise.resolve();
    },
  );
  assert.deepEqual(lost, []);
  assert.equal(exitPushes, 1);
});

test("read wiki access commits code only, and the wiki edit is lost at teardown", async () => {
  const job = await openJob("open-pr");
  try {
    write(job.repo, "README.md", "changed\n");
    write(job.docs, "Page.md", "new\n");
    const result = await job.commit(["-am", "Code"]);
    assert.equal(result.details.pushed, "code");
    assert.equal(result.details.wiki, null);
    assert.equal(refOf(job.wikiOrigin, BRANCH), "");
  } finally {
    job.close();
  }
  const lost = await closeJobCheckout(
    job.cfg,
    ISSUE,
    { root: job.root, repo: job.repo, docs: job.docs, wiki: "read" },
    null,
  );
  assert.deepEqual(lost, ["docs/Page.md"]);
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

for (const [stage, file] of DEFERRED_COMMITS) {
  test(`every push in the ${stage} stage is deferred and the remotes are unchanged`, async () => {
    const job = await openJob(stage);
    try {
      write(job.root, file, "changed\n");
      const result = await job.commit(["-m", "Deferred", "--", file]);
      assert.equal(result.isError, false);
      assert.equal(result.details.pushed, "deferred");
      assert.equal(refOf(job.origin, BRANCH), "");
      assert.equal(refOf(job.wikiOrigin, BRANCH), "");
      assert.deepEqual(pushesOf(job), []);
    } finally {
      job.close();
    }
  });
}

test("a plain git commit is refused in the code and wiki checkouts, and passes with ISSUE_PIPELINE_COMMIT=1", async () => {
  const job = await openJob("implement");
  try {
    for (const dir of [job.repo, job.docs]) {
      const args = ["-C", dir, "commit", "--allow-empty", "-m", "Direct"];
      const refused = spawnSync("git", args, { encoding: "utf8" });
      assert.notEqual(refused.status, 0, dir);
      assert.match(refused.stderr, HOOK_REFUSES);
      const passed = spawnSync("git", args, {
        encoding: "utf8",
        env: { ...process.env, ...COMMIT_PASS },
      });
      assert.equal(passed.status, 0, passed.stderr);
    }
  } finally {
    job.close();
  }
});
