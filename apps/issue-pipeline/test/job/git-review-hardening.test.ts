import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "../isolated-root-test-kit.ts";
import {
  delivery,
  eachAsync,
  fixture,
  git,
  pageLines,
  QUERIES,
  query,
  snapshot,
} from "./git-review-test-kit.ts";

const SENTINEL = "synthetic-outside-evidence";

test("implicit worktree queries never deliver evidence from outside the root", async () => {
  const { repo, tool } = fixture();
  const tracked = path.join(repo, "tracked");
  fs.mkdirSync(tracked);
  fs.writeFileSync(path.join(tracked, "file.txt"), "inside\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "tracked directory"]);
  fs.rmSync(tracked, { recursive: true });
  const outside = fs.mkdtempSync(path.join(isolatedRoot, "outside-"));
  fs.writeFileSync(path.join(outside, "file.txt"), `${SENTINEL}\n`);
  fs.symlinkSync(outside, tracked, "dir");
  await eachAsync(
    [["diff"], ["grep", "-e", SENTINEL], ["status", "--porcelain"]],
    async (argv) => {
      const result = await query(tool, repo, argv);
      assert.ok(!result.content[0]?.text.includes(`+${SENTINEL}`));
      assert.ok(!result.content[0]?.text.includes(`:${SENTINEL}`));
    },
  );
});

test("worktree queries cannot execute a submodule's configured fsmonitor", async () => {
  const { repo, tool } = fixture();
  const origin = fixture();
  git(repo, ["submodule", "add", origin.repo, "module"]);
  git(repo, ["commit", "-qm", "submodule"]);
  const marker = path.join(repo, "executed");
  const sentinel = path.join(repo, "sentinel");
  fs.writeFileSync(sentinel, `#!/bin/sh\nprintf invoked > '${marker}'\n`, {
    mode: 0o755,
  });
  git(path.join(repo, "module"), ["config", "core.fsmonitor", sentinel]);
  const before = snapshot(repo);
  await eachAsync([["diff"], ["status", "--porcelain"]], async (argv) => {
    const result = await query(tool, repo, argv);
    assert.equal(fs.existsSync(marker), false, JSON.stringify(result));
    assert.equal(result.isError, true);
    assert.ok("error" in result.details);
  });
  const committed = await query(tool, repo, ["show", "HEAD"]);
  assert.ok(
    pageLines(committed).some((line) => line.startsWith("+Subproject commit")),
  );
  await eachAsync(
    QUERIES.filter(([command]) => command !== "diff" && command !== "status"),
    async (argv) => {
      delivery(await query(tool, repo, argv));
      assert.equal(fs.existsSync(marker), false);
    },
  );
  assert.equal(snapshot(repo), before);
});

test("dangling escaping symlinks fail closed for explicit and implicit paths", async () => {
  const { repo, tool } = fixture();
  fs.unlinkSync(path.join(repo, "file.txt"));
  fs.symlinkSync(
    path.join(isolatedRoot, "missing", "file.txt"),
    path.join(repo, "file.txt"),
  );
  await eachAsync([["diff"], ["diff", "--", "file.txt"]], async (argv) => {
    const result = await query(tool, repo, argv);
    assert.equal(result.isError, true);
    assert.ok("error" in result.details);
  });
});

test("ancestry predicates deliver their exit status even when both outputs are empty", async () => {
  const { repo, tool } = fixture();
  const ancestor = await query(tool, repo, [
    "merge-base",
    "--is-ancestor",
    "HEAD~1",
    "HEAD",
  ]);
  const descendant = await query(tool, repo, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    "HEAD~1",
  ]);
  assert.equal(delivery(ancestor).exitCode, 0);
  assert.equal(delivery(descendant).exitCode, 1);
  assert.equal(delivery(ancestor).totalLines, 0);
  assert.equal(delivery(descendant).totalLines, 0);
  assert.equal(delivery(descendant).startLine, null);
});
