// The built workflow opens with the helpers' bundle, and the bundle doesn't
// change how the sweep's body runs. It builds into its own folder, so it never
// races install.test.mjs, which builds dist/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

// The bundle's first line: it defines the variable the body reads.
const BUNDLE_START = "var workflowModules = (() => {\n";
// A directive that would make the whole body strict.
const STRICT_DIRECTIVE = /^\s*["']use strict["']/u;

const script = new URL("../build.ts", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-bundle-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const built = spawnSync(process.execPath, [script, tmp], { encoding: "utf8" });

test("the built workflow opens with the helpers' bundle, with no strict directive", () => {
  assert.equal(built.status, 0, built.stderr);
  const workflow = fs.readFileSync(path.join(tmp, "workflow.js"), "utf8");
  assert.doesNotMatch(workflow, STRICT_DIRECTIVE);
  assert.ok(
    workflow.startsWith(BUNDLE_START),
    workflow.slice(0, BUNDLE_START.length),
  );
});
