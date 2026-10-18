// @ts-check
// A temporary HOME and pipeline root for tests of pure pipeline modules. A
// test imports this kit before it loads anything from src, then imports src
// dynamically, so src/pipeline-root.ts never resolves the machine's installed
// root. The kit checks that it did not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-home-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const isolatedRoot = path.join(home, "root");
// src runs its commands in the root, so it must exist.
fs.mkdirSync(isolatedRoot);
// Environment variables are named by strings, as src/process.ts takes them.
Object.assign(
  process.env,
  Object.fromEntries([
    ["HOME", home],
    ["ISSUE_PIPELINE_ROOT", isolatedRoot],
  ]),
);
const { ROOT } = await import("../src/pipeline-root.ts");
if (ROOT !== isolatedRoot) {
  throw new Error("the pipeline root isn't the test's temporary folder");
}

export { isolatedRoot };
