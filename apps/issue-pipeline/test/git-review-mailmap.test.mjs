// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { delivery, eachAsync, fixture, query } from "./git-review-test-kit.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

test("history queries never deliver an external symlinked mailmap's evidence", async () => {
  const { repo, tool } = fixture();
  const outside = path.join(isolatedRoot, "outside-mailmap");
  fs.writeFileSync(
    outside,
    "Outside Sentinel <outside@example.invalid> Test <test@example.invalid>\n",
  );
  fs.symlinkSync(outside, path.join(repo, ".mailmap"));
  await eachAsync(
    [
      ["blame", "--line-porcelain", "HEAD", "--", "file.txt"],
      ["log", "--format=full"],
      ["show", "HEAD"],
    ],
    async (argv) => {
      const result = await query(tool, repo, argv);
      assert.equal(delivery(result).exitCode, 0);
      assert.ok(!result.content[0]?.text.includes("Outside Sentinel"));
    },
  );
});
