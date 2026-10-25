// The code sync record (src/rebase.ts) a checkout keeps across a conflicted
// rebase: what it reads back from the git dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.ts";
import { git } from "./job-git-test-kit.ts";

const { readCodeSync, saveCodeSync }: typeof import("../src/rebase.ts") =
  await import("../src/rebase.ts");

// A SHA-1 commit id's hex length.
const SHA_LENGTH = 40;
const FROM = "a".repeat(SHA_LENGTH);
const ONTO = "b".repeat(SHA_LENGTH);

// Returns a fresh git checkout under the test's root
function checkout(): string {
  const wt = fs.mkdtempSync(path.join(isolatedRoot, "rebase-"));
  git(["init", "-q", wt]);
  return wt;
}

test("a code sync record reads back as saved, and a checkout without one has none", () => {
  const wt = checkout();
  assert.equal(readCodeSync(wt), undefined);
  saveCodeSync(wt, { from: FROM, onto: ONTO });
  assert.deepEqual(readCodeSync(wt), { from: FROM, onto: ONTO });
});

test("a code sync record written while the pipeline had a wiki reads without its wiki flag", () => {
  const wt = checkout();
  const file = path.join(wt, ".git", "pipeline-code-sync.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ from: FROM, onto: ONTO, wikiResolved: true }),
  );
  assert.deepEqual(readCodeSync(wt), { from: FROM, onto: ONTO });
});
