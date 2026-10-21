// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { snapshot } from "./commit-selection-test-kit.mjs";
import { refOf } from "./job-git-test-kit.mjs";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  openJob,
  pushesOf,
  write,
} from "./pipeline-commit-test-kit.mjs";
import { saveAuthority } from "./write-authority-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");
const REFUSED = /pipeline_commit refused/u;
const STAGE_FAILURE = /index\.lock/u;
const CODE_REFUSAL = /code.*(?:merged|read.only|authority)/u;
const HOOK_MODE = 0o755;

for (const selection of ["repo/link", "repo/link/Page.md", "repo/*"]) {
  test(`escaping symlink in ${selection} refuses authorized paths before any staging`, async () => {
    const job = await openJob("merge");
    try {
      write(job.repo, "new.txt", "new\n");
      write(job.docs, "Page.md", "outside\n");
      fs.symlinkSync(job.docs, path.join(job.repo, "link"), "dir");
      const before = snapshot(job);
      await assert.rejects(
        job.commit([
          "-m",
          "Escape",
          "--",
          "repo/new.txt",
          "docs/Page.md",
          selection,
        ]),
        REFUSED,
      );
      assert.deepEqual(snapshot(job), before);
      assert.deepEqual(pushesOf(job), []);
    } finally {
      job.close();
    }
  });
}

test("a staging failure retains new and modified files and existing staged work, reporting the independent wiki commit", async () => {
  const job = await openJob("merge");
  try {
    write(job.repo, "README.md", "modified\n");
    write(job.repo, "new.txt", "new\n");
    write(job.repo, "staged.txt", "staged\n");
    git(job.repo, ["add", "--", "staged.txt"]);
    write(job.docs, "Page.md", "wiki\n");
    const [before] = snapshot(job);
    const lock = path.join(job.repo, ".git/index.lock");
    fs.writeFileSync(lock, "owned by another process\n");
    const result = await job.commit([
      "-m",
      "Fails staging",
      "--",
      "repo/new.txt",
      "repo/README.md",
      "docs/Page.md",
    ]);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, STAGE_FAILURE);
    assert.equal(result.details.pushed, "none");
    assert.equal(typeof result.details.wiki.sha, "string");
    assert.ok(result.content[0].text.includes(result.details.wiki.sha));
    assert.deepEqual(snapshot(job)[0], before);
    assert.equal(fs.readFileSync(lock, "utf8"), "owned by another process\n");
    assert.equal(
      fs.readFileSync(path.join(job.repo, "new.txt"), "utf8"),
      "new\n",
    );
    assert.deepEqual(pushesOf(job), []);
    assert.equal(refOf(job.wikiOrigin, BRANCH), "");
  } finally {
    job.close();
  }
});

test("a refused new-file push retains the local commit, and a later call must establish fresh authority", async () => {
  const job = await openJob("merge");
  try {
    const hook = path.join(job.origin, "hooks/pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: HOOK_MODE });
    write(job.repo, "new.txt", "first\n");
    write(job.repo, "README.md", "first\n");
    const first = await job.commit([
      "-m",
      "First",
      "--",
      "repo/new.txt",
      "repo/README.md",
    ]);
    const local = headOf(job.repo);
    assert.equal(first.details.code.sha, local);
    assert.equal(first.details.pushed, "none");
    assert.equal(typeof first.details.pushError, "string");
    assert.equal(refOf(job.origin, BRANCH), "");
    fs.rmSync(hook);
    saveAuthority(job.cfg, {
      ...newIssueState(ISSUE),
      branch: job.branch,
      stage: "merge",
      codeMerged: { pr: 42, sha: local },
    });
    write(job.repo, "another.txt", "second\n");
    const second = await job.commit(["-m", "Second", "--", "repo/another.txt"]);
    assert.equal(second.details.pushed, "none");
    assert.match(second.details.pushError, CODE_REFUSAL);
    assert.equal(headOf(job.repo), second.details.code.sha);
    assert.equal(git(job.repo, ["rev-parse", "HEAD~1"]), local);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});
