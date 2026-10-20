// @ts-check
// Pinning precedes checkout/setup and must not need an installed runtime root.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { writeBrain } from "./brain-test-kit.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "brain-root-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const missingRoot = path.join(temporary, "not-installed");
Object.assign(
  process.env,
  Object.fromEntries([["ISSUE_PIPELINE_ROOT", missingRoot]]),
);
const { openBrain } = await import("../src/job/brain.ts");
const { ROOT } = await import("../src/pipeline-root.ts");

/** @param {string} dir @param {string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

test("prompt HEAD provenance works before the runtime root exists, without creating it", () => {
  const brain = writeBrain(path.join(temporary, "brain"));
  git(brain, ["init", "-q"]);
  git(brain, ["add", "."]);
  git(brain, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Prompt pages",
  ]);
  const head = git(brain, ["rev-parse", "HEAD"]);
  assert.equal(ROOT, missingRoot);
  assert.equal(fs.existsSync(ROOT), false);
  const { pinned } = openBrain(brain, "review");
  assert.equal(pinned[0]?.head, head);
  const inner = writeBrain(path.join(brain, "inner"));
  assert.equal(openBrain(inner, "review").pinned[0]?.head, null);
  assert.equal(fs.existsSync(ROOT), false);
});
