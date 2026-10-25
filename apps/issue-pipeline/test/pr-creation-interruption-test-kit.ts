// A private fake-gh wrapper interrupts the actual create/save window. All
// commands go only to the stateful local fake and its temporary bare origin.

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import { savedState } from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";

const RUN_MS = 60_000;
const STATE = /<!-- agent-pipeline:state\n(?<json>[\s\S]*?)\n-->/u;

function localGh(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  // The coordination transport sends its git-data bodies on stdin (#167).
  let input = "";
  if (args.includes("--input")) {
    input = fs.readFileSync(0, "utf8");
  }
  return spawnSync(process.execPath, [file, ...args], {
    env,
    input,
    encoding: "utf8",
    timeout: RUN_MS,
  });
}

function localGit(repo: string, args: string[]): string {
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

function mergeGh(
  original: string,
  args: string[],
  mergeAccount: string,
): SpawnSyncReturns<string> {
  let identity = "dev";
  let account = "dev-bot";
  if (args[0] === "api") {
    identity = "merge";
    account = mergeAccount;
  }
  const env = {
    ...process.env,
    ...Object.fromEntries([
      ["GH_TOKEN", `fake-pipeline-${identity}--${account}`],
    ]),
  };
  return localGh(original, args, env);
}

function externalMerge(root: string, ghDir: string, original: string): void {
  const world = readWorld(ghDir);
  const [change] = world.prs;
  if (change === undefined) {
    throw new Error("no created PR");
  }
  const branch = `refs/heads/${change.head}`;
  const head = localGit(world.origin, ["rev-parse", branch]);
  for (const args of [
    ["pr", "ready", String(change.number)],
    [
      "api",
      `repos/${world.repo}/merges`,
      "--method",
      "POST",
      "--include",
      "-f",
      `base=${change.base}`,
      "-f",
      `head=${head}`,
    ],
  ]) {
    const reply = mergeGh(original, args, world.account);
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

function runCreationInterruption(
  root: string,
  ghDir: string,
  mode: string,
): void {
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

function interruptCreation(flow: Flow, mode: string): void {
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
