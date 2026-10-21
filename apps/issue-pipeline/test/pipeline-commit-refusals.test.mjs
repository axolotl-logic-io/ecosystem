// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { snapshot } from "./commit-selection-test-kit.mjs";
import { git, openJob, pushesOf, write } from "./pipeline-commit-test-kit.mjs";

const REFUSAL = /pipeline_commit refused/u;

for (const forbidden of [
  "/absolute/file",
  "repo/../docs/Page.md",
  "outside/file",
  ":(top)repo/README.md",
  "repo/:(top)README.md",
  "repo/./:(exclude)README.md",
  "repo/.git/config",
  "repo/link/file",
  "repo/link",
  "repo/README.md",
  "repo",
  "repo/*",
]) {
  test(`mixed valid selections and forbidden ${forbidden} refuse before either checkout changes`, async () => {
    const job = await openJob("merge", { allowed: ["src/**"] });
    try {
      fs.mkdirSync(path.join(job.repo, "src"));
      write(job.repo, "src/new.txt", "valid\n");
      write(job.repo, "src/modified.txt", "staged\n");
      git(job.repo, ["add", "--", "src/modified.txt"]);
      write(job.repo, "src/modified.txt", "working\n");
      write(job.repo, "README.md", "not authorized\n");
      write(job.docs, "Page.md", "wiki\n");
      fs.symlinkSync(job.docs, path.join(job.repo, "link"), "dir");
      const before = snapshot(job);
      await assert.rejects(
        job.commit([
          "-m",
          "Refused",
          "--",
          "docs/Page.md",
          "repo/src/new.txt",
          forbidden,
        ]),
        REFUSAL,
      );
      assert.deepEqual(snapshot(job), before);
      assert.equal(
        fs.readFileSync(path.join(job.repo, "src/new.txt"), "utf8"),
        "valid\n",
      );
      assert.equal(
        fs.readFileSync(path.join(job.docs, "Page.md"), "utf8"),
        "wiki\n",
      );
      assert.deepEqual(pushesOf(job), []);
    } finally {
      job.close();
    }
  });
}

test("a broad directory containing one forbidden descendant refuses even when the directory itself matches a glob", async () => {
  const job = await openJob("merge", { allowed: ["src", "src/allowed.txt"] });
  try {
    fs.mkdirSync(path.join(job.repo, "src"));
    write(job.repo, "src/allowed.txt", "valid\n");
    write(job.repo, "src/forbidden.txt", "keep\n");
    const before = snapshot(job);
    await assert.rejects(
      job.commit(["-m", "Broad", "--", "repo/src"]),
      REFUSAL,
    );
    assert.deepEqual(snapshot(job), before);
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});

for (const flag of [
  "--include",
  "-i",
  "--interactive",
  "--patch",
  "-p",
  "--no-verify",
  "-n",
  "--amend",
  "--no-dry-run",
  "--no-only",
]) {
  test(`${flag} cannot bypass selection or hooks`, async () => {
    const job = await openJob("implement");
    try {
      write(job.repo, "new.txt", "new\n");
      write(job.repo, "staged.txt", "unrelated\n");
      git(job.repo, ["add", "--", "staged.txt"]);
      const before = snapshot(job);
      await assert.rejects(
        job.commit([flag, "-m", "Refused", "--", "repo/new.txt"]),
        REFUSAL,
      );
      assert.deepEqual(snapshot(job), before);
      assert.deepEqual(pushesOf(job), []);
    } finally {
      job.close();
    }
  });
}

/** @type {{stage: import("../src/stages.ts").Stage, codeWritable: boolean, allowed?: string[]}[]} */
const RESTRICTED = [
  { stage: "author", codeWritable: true },
  { stage: "review", codeWritable: true, allowed: [] },
  { stage: "merge", codeWritable: false },
];
for (const options of RESTRICTED) {
  test(`${options.stage} with restricted code scope cannot stage or commit new code`, async () => {
    const job = await openJob(options.stage, options);
    try {
      write(job.repo, "new.txt", "keep\n");
      write(job.docs, "Page.md", "wiki\n");
      const before = snapshot(job);
      await assert.rejects(
        job.commit(["-m", "Refused", "--", "docs/Page.md", "repo/new.txt"]),
        REFUSAL,
      );
      assert.deepEqual(snapshot(job), before);
      assert.deepEqual(pushesOf(job), []);
    } finally {
      job.close();
    }
  });
}

test("implicit tracked-code commits cannot exceed allowed code globs", async () => {
  const job = await openJob("review", { allowed: ["src/**"] });
  try {
    write(job.repo, "README.md", "forbidden\n");
    write(job.docs, "Page.md", "wiki\n");
    const before = snapshot(job);
    await assert.rejects(job.commit(["-am", "Implicit"]), REFUSAL);
    assert.deepEqual(snapshot(job), before);
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});
