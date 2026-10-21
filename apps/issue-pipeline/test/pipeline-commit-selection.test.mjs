// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { snapshot } from "./commit-selection-test-kit.mjs";
import {
  git,
  headOf,
  JOB_STARTED_AT,
  KEY,
  openJob,
  pushesOf,
  write,
} from "./pipeline-commit-test-kit.mjs";

const SESSION_TRAILER = `Pipeline-Session: ${KEY}@${JOB_STARTED_AT}`;
const NEW = ["new.txt"];
const MODIFIED = ["README.md"];
const MIXED = [...NEW, ...MODIFIED];

/** @type {{stage: import("../src/stages.ts").Stage, selections: string[][]}[]} */
const WRITERS = [
  { stage: "implement", selections: [NEW] },
  { stage: "review", selections: [MODIFIED, MIXED] },
  { stage: "merge", selections: [NEW, MODIFIED, MIXED] },
];
for (const { stage, selections } of WRITERS) {
  for (const selected of selections) {
    test(`${stage} commits explicit ${selected.join(" and ")} with attribution through the push socket`, async () => {
      const job = await openJob(stage);
      try {
        for (const file of selected) {
          write(job.repo, file, "selected\n");
        }
        const wiki = headOf(job.docs);
        const result = await job.commit([
          "-m",
          "Selected",
          "--",
          ...selected.map((file) => `repo/${file}`),
        ]);
        assert.equal(result.isError, false);
        assert.equal(result.details.pushed, "code");
        assert.equal(result.details.wiki, null);
        assert.equal(headOf(job.docs), wiki);
        assert.deepEqual(
          git(job.repo, [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "HEAD",
          ])
            .split("\n")
            .sort(),
          [...selected].sort(),
        );
        assert.ok(
          git(job.repo, ["log", "-1", "--format=%B"]).includes(SESSION_TRAILER),
        );
        assert.deepEqual(pushesOf(job), [
          { repo: "code", sha: headOf(job.repo) },
        ]);
      } finally {
        job.close();
      }
    });
  }
}

test("explicit mixed selection preserves unrelated index, working files and wiki edits", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "staged.txt", "staged version\n");
    git(job.repo, ["add", "--", "staged.txt"]);
    write(job.repo, "staged.txt", "working version\n");
    write(job.repo, "untracked.txt", "untracked\n");
    write(job.docs, "Page.md", "wiki\n");
    write(job.repo, "README.md", "modified\n");
    write(job.repo, "new.txt", "new\n");
    const staged = git(job.repo, ["diff", "--cached", "--binary"]);
    const [, wiki] = snapshot(job);
    const result = await job.commit([
      "-m",
      "Mixed",
      "--",
      "repo/new.txt",
      "repo/README.md",
    ]);
    assert.equal(result.details.pushed, "code");
    assert.equal(result.details.wiki, null);
    assert.deepEqual(
      git(job.repo, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "HEAD",
      ]).split("\n"),
      ["README.md", "new.txt"],
    );
    assert.equal(git(job.repo, ["diff", "--cached", "--binary"]), staged);
    assert.equal(
      fs.readFileSync(path.join(job.repo, "staged.txt"), "utf8"),
      "working version\n",
    );
    assert.equal(
      fs.readFileSync(path.join(job.repo, "untracked.txt"), "utf8"),
      "untracked\n",
    );
    assert.deepEqual(snapshot(job)[1], wiki);
  } finally {
    job.close();
  }
});

test("unnamed tracked-code commits do not stage arbitrary new code but keep writable wiki selection", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "README.md", "modified\n");
    write(job.repo, "new.txt", "new\n");
    write(job.docs, "Page.md", "new wiki\n");
    const result = await job.commit(["-am", "Tracked and wiki"]);
    assert.equal(result.details.pushed, "both");
    assert.equal(
      git(job.repo, ["ls-tree", "--name-only", "HEAD", "new.txt"]),
      "",
    );
    assert.equal(
      git(job.repo, ["ls-files", "--others", "--exclude-standard"]),
      "new.txt",
    );
    assert.equal(git(job.docs, ["show", "HEAD:Page.md"]), "new wiki");
  } finally {
    job.close();
  }
});

for (const flag of ["--dry-run", "--dry", "--short", "--porcelain", "-z"]) {
  test(`${flag} simulates new and modified selections without changing either checkout or requesting a push`, async () => {
    const job = await openJob("merge");
    try {
      write(job.repo, "README.md", "modified\n");
      write(job.repo, "new.txt", "new\n");
      write(job.repo, "staged.txt", "staged\n");
      git(job.repo, ["add", "--", "staged.txt"]);
      write(job.docs, "Page.md", "wiki\n");
      const before = snapshot(job);
      const result = await job.commit([
        flag,
        "-m",
        "Dry",
        "--",
        "repo/new.txt",
        "repo/README.md",
        "docs/Page.md",
      ]);
      assert.equal(result.isError, false);
      assert.equal(result.details.pushed, "none");
      assert.deepEqual(snapshot(job), before);
      assert.deepEqual(pushesOf(job), []);
      assert.equal(
        fs.readFileSync(path.join(job.repo, "new.txt"), "utf8"),
        "new\n",
      );
      assert.equal(
        fs.readFileSync(path.join(job.docs, "Page.md"), "utf8"),
        "wiki\n",
      );
    } finally {
      job.close();
    }
  });
}

test("authorized directory and pattern selection stages only its concrete descendants", async () => {
  const job = await openJob("merge", { allowed: ["src/**"] });
  try {
    fs.mkdirSync(path.join(job.repo, "src"));
    write(job.repo, "src/new.txt", "one\n");
    write(job.repo, "src/another.txt", "two\n");
    write(job.repo, "elsewhere.txt", "keep\n");
    const result = await job.commit(["-m", "Directory", "--", "repo/src"]);
    assert.equal(result.details.pushed, "code");
    assert.equal(
      git(job.repo, ["ls-tree", "-r", "--name-only", "HEAD", "src"]),
      "src/another.txt\nsrc/new.txt",
    );
    write(job.repo, "src/third.txt", "three\n");
    const next = await job.commit(["-m", "Pattern", "--", "repo/src/*.txt"]);
    assert.equal(next.details.pushed, "code");
    assert.equal(
      git(job.repo, ["ls-files", "--others", "--exclude-standard"]),
      "elsewhere.txt",
    );
  } finally {
    job.close();
  }
});
