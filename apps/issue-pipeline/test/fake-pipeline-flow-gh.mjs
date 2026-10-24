// @ts-check
// The full-flow tests' fake GitHub: a stateful `gh` (fake-pipeline-flow-gh-cli.mjs)
// that keeps one repo's issues, comments, labels and pull requests in a
// world (fake-pipeline-flow-gh-world.mjs) and answers only the gh calls the
// pipeline makes, refusing any other. Its pull requests live in a real bare
// git origin. It stands in for GitHub only and never reaches the network.
// This module installs it and lets a test seed and read its world.
import fs from "node:fs";
import path from "node:path";
import { targetPushes } from "./fake-pipeline-flow-gh-native.mjs";
import {
  now,
  postComment,
  withWorld,
  writeWorld,
} from "./fake-pipeline-flow-gh-world.mjs";

const FIRST_ID = 1000;
const EXECUTABLE = 0o755;
const CLI = new URL("fake-pipeline-flow-gh-cli.mjs", import.meta.url).pathname;

/**
 * A fresh world for `repo`, and the `gh` in `bin` that serves it.
 * @param {{ dir: string, bin: string, repo: string, account: string, collaborators: string[], origin: string, baseBranch: string }} where
 */
function installFlowGh({
  dir,
  bin,
  repo,
  account,
  collaborators,
  origin,
  baseBranch,
}) {
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
  const source = `#!/usr/bin/env node\nimport { runFlowGh } from ${JSON.stringify(CLI)};\nrunFlowGh(${JSON.stringify(dir)});\n`;
  fs.writeFileSync(path.join(bin, "gh"), source, { mode: EXECUTABLE });
}

/**
 * Opens issue `number`, written by `login`.
 * @param {string} dir
 * @param {{ number: number, title: string, body: string, login: string }} opened
 */
function openIssue(dir, { number, title, body, login }) {
  withWorld(dir, (world) => {
    const createdAt = now();
    const fresh = { number, title, body, login, createdAt, labels: [] };
    world.issues.push({ ...fresh, state: "open", stateReason: null });
  });
}

/**
 * A person's comment on issue `n`, as GitHub adds it.
 * @param {string} dir @param {number} n @param {string} login @param {string} body
 * @returns {number} its id
 */
function humanComment(dir, n, login, body) {
  return withWorld(dir, (world) => postComment(world, n, login, body).id);
}

/** @param {string} dir @returns {string[][]} every gh call, in order */
function ghCalls(dir) {
  return fs
    .readFileSync(path.join(dir, "calls.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Every gh call with the fake token's account: its identity (dev or merge)
 * and login, or nulls for a call with no fake token.
 * @param {string} dir
 * @returns {{ identity: string | null, login: string | null, args: string[] }[]}
 */
function ghAccountCalls(dir) {
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
