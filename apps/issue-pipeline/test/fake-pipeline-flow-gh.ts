// The full-flow tests' fake GitHub: a stateful `gh` (fake-pipeline-flow-gh-cli.ts)
// that keeps one repo's issues, comments, labels and pull requests in a
// world (fake-pipeline-flow-gh-world.ts) and answers only the gh calls the
// pipeline makes, refusing any other. Its pull requests live in a real bare
// git origin. It stands in for GitHub only and never reaches the network.
// This module installs it and lets a test seed and read its world.
import fs from "node:fs";
import path from "node:path";
import { targetPushes } from "./fake-pipeline-flow-gh-native.ts";
import {
  now,
  postComment,
  withWorld,
  writeWorld,
} from "./fake-pipeline-flow-gh-world.ts";
import { tsShim } from "./ts-shim.ts";

const FIRST_ID = 1000;
const EXECUTABLE = 0o755;
const CLI: string = new URL("fake-pipeline-flow-gh-cli.ts", import.meta.url)
  .pathname;

// A fresh world for `repo`, and the `gh` in `bin` that serves it.
function installFlowGh({
  dir,
  bin,
  repo,
  account,
  collaborators,
  origin,
  baseBranch,
}: {
  dir: string;
  bin: string;
  repo: string;
  account: string;
  collaborators: string[];
  origin: string;
  baseBranch: string;
}): void {
  fs.mkdirSync(dir, { recursive: true });
  writeWorld(dir, {
    repo,
    account,
    collaborators,
    origin,
    baseBranch,
    nativePushStart: targetPushes(origin, baseBranch).length,
    nativePushesSeen: 0,
    nextId: FIRST_ID,
    issues: [],
    comments: [],
    repoLabels: [],
    prs: [],
    unsupported: [],
  });
  fs.writeFileSync(path.join(dir, "calls.jsonl"), "");
  const source = tsShim(CLI, "runFlowGh", [dir]);
  fs.writeFileSync(path.join(bin, "gh"), source, { mode: EXECUTABLE });
}

// Opens issue `number`, written by `login`.
function openIssue(
  dir: string,
  {
    number,
    title,
    body,
    login,
  }: { number: number; title: string; body: string; login: string },
): void {
  withWorld(dir, (world) => {
    const createdAt = now();
    const fresh = { number, title, body, login, createdAt, labels: [] };
    world.issues.push({ ...fresh, state: "open", stateReason: null });
  });
}

// A person's comment on issue `n`, as GitHub adds it.
// Returns its id
function humanComment(
  dir: string,
  n: number,
  login: string,
  body: string,
): number {
  return withWorld(dir, (world) => postComment(world, n, login, body).id);
}

// Returns every gh call, in order
function ghCalls(dir: string): string[][] {
  return fs
    .readFileSync(path.join(dir, "calls.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

// Every gh call with the fake token's account: its identity (dev or merge)
// and login, or nulls for a call with no fake token.
function ghAccountCalls(
  dir: string,
): { identity: string | null; login: string | null; args: string[] }[] {
  const file = path.join(dir, "accounts.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

export { ghAccountCalls, ghCalls, humanComment, installFlowGh, openIssue };
