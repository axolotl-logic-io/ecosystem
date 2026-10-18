// @ts-check
// Establish isolated publication fixtures before real revision imports.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = fs.mkdtempSync("/tmp/issue-pipeline-publication-ops-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, "home");
fs.mkdirSync(home);
// Environment variables are named by strings, as src/process.ts takes them.
Object.assign(
  process.env,
  Object.fromEntries([
    ["ISSUE_PIPELINE_ROOT", root],
    ["HOME", home],
  ]),
);

export { home, root };
