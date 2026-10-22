// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "../isolated-root-test-kit.mjs";
import { eachAsync, fixture, query } from "./git-review-test-kit.mjs";

const { reviewer } = await import("../../src/job/git-review.ts");
const ROOT_ERROR = /PI_GIT_REVIEW_ROOTS/u;
const LEAVES_ROOT = /repository|Unsupported path/u;
test("rejects absent, empty, malformed and relative root authority", async () => {
  const { repo } = fixture();
  await eachAsync(
    [
      undefined,
      "",
      "[]",
      "{}",
      "null",
      '"/repo"',
      '["relative"]',
      "[2]",
      '["/missing"]',
    ],
    async (roots) => {
      const result = await query(reviewer(roots), repo, ["status"]);
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", ROOT_ERROR);
      assert.ok("error" in result.details);
    },
  );
});

test("rejects cwd escapes, prefixes, traversal and escaping symlinks", async () => {
  const { repo, tool } = fixture();
  const sibling = `${repo}-sibling`;
  fs.mkdirSync(sibling);
  const symlink = path.join(repo, "escape");
  fs.symlinkSync(sibling, symlink, "dir");
  await eachAsync(
    [
      isolatedRoot,
      sibling,
      path.join(repo, ".."),
      symlink,
      `${repo}/../${path.basename(sibling)}`,
    ],
    async (cwd) => {
      const result = await query(tool, cwd, ["status"]);
      assert.equal(result.isError, true);
      assert.ok("error" in result.details);
    },
  );
});

test("rejects escaped paths and revision paths before reading", async () => {
  const { repo, tool } = fixture();
  fs.symlinkSync(isolatedRoot, path.join(repo, "escape"), "dir");
  const paths = [
    "/outside",
    "../file",
    "dir/../../file",
    "escape/missing",
    ":(top)../file",
    ":(glob)**",
    ".git/config",
    "dir/../file",
  ];
  await eachAsync(paths, async (file) => {
    const result = await query(tool, repo, ["diff", "--", file]);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", LEAVES_ROOT);
  });
  await eachAsync(["../secret", "/secret", ":(top)../secret"], async (file) => {
    const result = await query(tool, repo, ["cat-file", "-p", `HEAD:${file}`]);
    assert.equal(result.isError, true);
    assert.ok("error" in result.details);
  });
});

test("revision and path ambiguity cannot hide an escaping path before --", async () => {
  const { repo, tool } = fixture();
  fs.symlinkSync(isolatedRoot, path.join(repo, "escape"), "dir");
  await eachAsync(
    ["escape/missing", "dir/../../outside", "dir/.git/config"],
    async (operand) => {
      const result = await query(tool, repo, ["diff", operand]);
      assert.equal(result.isError, true);
      assert.ok("error" in result.details);
    },
  );
});

test("rejects metadata indirection outside roots", async () => {
  await eachAsync(
    ["commondir", "objects/info/alternates", "objects/info/http-alternates"],
    async (name) => {
      const { repo, tool } = fixture();
      fs.writeFileSync(path.join(repo, ".git", name), "/outside\n");
      const result = await query(tool, repo, ["status"]);
      assert.equal(result.isError, true);
      assert.ok("error" in result.details);
    },
  );
  const { repo, tool } = fixture();
  fs.symlinkSync(isolatedRoot, path.join(repo, ".git", "refs", "outside"));
  assert.equal((await query(tool, repo, ["log"])).isError, true);
  const another = fixture();
  fs.renameSync(
    path.join(another.repo, ".git"),
    path.join(another.repo, "metadata"),
  );
  fs.writeFileSync(
    path.join(another.repo, ".git"),
    `gitdir: ${path.join(another.repo, "metadata")}\n`,
  );
  assert.equal(
    (await query(another.tool, another.repo, ["status"])).isError,
    true,
  );
});
