// @ts-check
// A private fake-gh wrapper interrupts the actual create/save window. All
// commands go only to the stateful local fake and its temporary bare origin.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { readWorld } from "./pipeline-flow-gh-world.mjs";
import { savedState } from "./pipeline-flow-script.mjs";

const RUN_MS = 60_000;
const STATE = /<!-- agent-pipeline:state\n(?<json>[\s\S]*?)\n-->/u;

/** @param {string} file @param {string[]} args @returns {import("node:child_process").SpawnSyncReturns<string>} */
function localGh(file, args) {
  return spawnSync(process.execPath, [file, ...args], {
    env: process.env,
    encoding: "utf8",
    timeout: RUN_MS,
  });
}

/** @param {string} repo @param {string[]} args @returns {string} */
function localGit(repo, args) {
  const env = {
    ...process.env,
    ...Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
  };
  const result = spawnSync("git", ["-C", repo, ...args], {
    env,
    encoding: "utf8",
    timeout: RUN_MS,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

/** @param {string} root @param {string} ghDir @param {string} original */
function externalMerge(root, ghDir, original) {
  const world = readWorld(ghDir);
  const [change] = world.prs;
  if (change === undefined) {
    throw new Error("no created PR");
  }
  const branch = `refs/heads/${change.head}`;
  const head = localGit(world.origin, ["rev-parse", branch]);
  for (const args of [
    ["pr", "ready", String(change.number)],
    ["pr", "merge", String(change.number), "--match-head-commit", head],
  ]) {
    const reply = localGh(original, args);
    if (reply.status !== 0) {
      throw new Error(reply.stderr);
    }
  }
  const repo = path.join(
    root,
    "work",
    "o__r",
    "jobs",
    "issue-7-implement",
    "repo",
  );
  fs.writeFileSync(path.join(repo, "greet.txt"), "exact interrupted local C\n");
  localGit(repo, ["add", "greet.txt"]);
  localGit(repo, ["commit", "-m", "Interrupted local work"]);
  const local = localGit(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(
    path.join(repo, "dirty.txt"),
    "exact interrupted dirty work\n",
  );
  fs.writeFileSync(
    path.join(root, "interruption.json"),
    JSON.stringify({
      head,
      local,
      before: savedState(world),
      pr: change.number,
    }),
  );
}

/** @param {string} root @param {string} ghDir @param {string} mode */
function runCreationInterruption(root, ghDir, mode) {
  const original = path.join(root, "local-gh.mjs");
  const args = process.argv.slice(2);
  const marker = path.join(root, "creation-interrupted");
  const field = args.find((arg) => arg.startsWith("body=")) ?? "";
  const { json } = STATE.exec(field)?.groups ?? {};
  const bindsPr =
    args.includes("PATCH") &&
    json !== undefined &&
    JSON.parse(json).pr !== null;
  if (mode === "failed-save" && bindsPr && !fs.existsSync(marker)) {
    externalMerge(root, ghDir, original);
    fs.writeFileSync(marker, "save failed");
    process.stderr.write("fake authority save refused");
    process.exitCode = 1;
    return;
  }
  const reply = localGh(original, args);
  if (
    args[0] === "pr" &&
    args[1] === "create" &&
    reply.status === 0 &&
    mode !== "failed-save"
  ) {
    externalMerge(root, ghDir, original);
    fs.writeFileSync(marker, "create completed before save");
    if (mode === "interrupted-create") {
      process.stderr.write("fake create reply interrupted");
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(reply.stdout);
  process.stderr.write(reply.stderr);
  process.exitCode = reply.status ?? 1;
}

/** @param {import("./pipeline-flow-kit.mjs").Flow} flow @param {string} mode */
function interruptCreation(flow, mode) {
  const gh = path.join(flow.tmp, "bin", "gh");
  fs.renameSync(gh, path.join(flow.root, "local-gh.mjs"));
  const kit = new URL(import.meta.url).pathname;
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node\nimport { runCreationInterruption } from ${JSON.stringify(kit)};\nrunCreationInterruption(${JSON.stringify(flow.root)}, ${JSON.stringify(flow.ghDir)}, ${JSON.stringify(mode)});\n`,
    { mode: 0o755 },
  );
}

export { interruptCreation, runCreationInterruption };
