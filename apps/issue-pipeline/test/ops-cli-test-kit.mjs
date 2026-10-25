// @ts-check
// The harness for the ops CLI tests (test/ops-*.test.mjs): a temporary
// pipeline root with a bare origin on `integration`, a config pointing at it,
// a fake gh first on PATH, and askOps(), which sends one request to
// src/ops.ts as the workflow frames it. Times in replies and gh writes are
// replaced with TIME, so no assertion depends on the clock.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.mjs";
import { loseOwnership } from "./fake-ownership.mjs";
import { effectsOf } from "./gh-effects-test-kit.mjs";
import { runOps, setEnv } from "./ops-run-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { GhEffect } from "./gh-effects-test-kit.mjs" */

import { claimComment as claimWireComment } from "./fake-gh.mjs";

const ACCOUNT = "bot";
const ALLOWED = "alice";
const TIME = "<time>";
const ISO_TIME = /(?<stamp>\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?Z)/gu;
// Every label ensureLabels wants, so a sweep creates none.
const ALL_LABELS = [
  "agent:working",
  "agent:needs-info",
  "agent:split",
  "agent:merged",
];

const root = fs.mkdtempSync("/tmp/issue-pipeline-ops-cli-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

/** @param {string} command @returns {string} */
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

sh(
  `cd ${root} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null; cd seed && git config user.email a@b && git config user.name a && echo 1 > f && git add f && git commit -qm base && git push -q origin HEAD:integration`,
);

// The ops child runs with this root and HOME (askOps); this process's
// pipeline modules read the same, set before any of them loads.
setEnv("ISSUE_PIPELINE_ROOT", root);
setEnv("HOME", root);
const pipelineRoot = await import("../src/pipeline-root.ts");
if (pipelineRoot.ROOT !== root || pipelineRoot.HOME !== root) {
  throw new Error(
    "the pipeline root isn't the ops CLI tests' temporary folder",
  );
}
const fakeGh = installFakeGh();
const requireGhReplies = fakeGh.requireReplies;
const { STOPS } = await import("../src/stops.ts");
const { ghIsRead } = await import("../src/github.ts");
// The config as a sweep reports it. config.ts is outside #183's move.
const { loadConfig, publicConfig } = await import("../src/config.ts");
const labelNames = [...ALL_LABELS, ...STOPS.map((stop) => stop.label.name)];

// Writes a config with `extra` over the base settings and returns its path.
/** @param {object} extra @returns {string} */
function configWith(extra) {
  const file = path.join(root, `config-${fs.readdirSync(root).length}.json`);
  const base = {
    repo: "o/r",
    ...credentialConfig(ACCOUNT),
    allowedUsers: [ALLOWED],
    cloneUrl: path.join(root, "origin.git"),
    baseBranch: "integration",
    commands: { test: "true" },
  };
  fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }));
  return file;
}

const CONFIG = configWith({});

/** @param {string} file @returns {object} */
function publicConfigOf(file) {
  return publicConfig(loadConfig(file));
}

// `text` with its times replaced by TIME, as replies and writes are.
/** @param {string} text @returns {string} */
function timeless(text) {
  return text.replace(ISO_TIME, TIME);
}

// The reply to `request`, sent bound with the base config unless it names
// one.
/** @param {object} request @param {boolean} [unbound] @returns {unknown} */
function askOps(request, unbound = false) {
  const stdout = runOps({ config: CONFIG, request, root, home: root, unbound });
  return JSON.parse(timeless(JSON.stringify(JSON.parse(stdout))));
}

// Queues gh's replies, and forgets earlier calls.
/** @param {readonly GhReply[]} replies @returns {void} */
function reply(replies) {
  fakeGh.reply(replies);
}

// The calls that change GitHub, in order, with times replaced: what a test
// checks for GitHub-visible effects, whatever reads came between them.
/** @returns {string[][]} */
function writes() {
  return fakeGh.writes(ghIsRead).map((args) => args.map(timeless));
}

// What those writes show on GitHub (see gh-effects-test-kit.mjs).
/** @returns {GhEffect[]} */
function effects() {
  return effectsOf(writes());
}

// A comment as listComments reads it.
/** @param {number} id @param {string} body @param {string} [login] @param {string} [at] @returns {object} */
function issueComment(id, body, login = ACCOUNT, at = "2026-10-15T01:00:00Z") {
  return githubComment({ id, body, login, created: at, updated: at });
}

/** @param {number} id @param {object} state @returns {object} */
function stateComment(id, state) {
  return issueComment(
    id,
    `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
  );
}

// gh's reply to listComments for issue `n`.
/** @param {number} n @param {readonly unknown[]} comments @returns {GhReply} */
function commentsReply(n, comments) {
  return {
    when: `issues/${n}/comments?per_page`,
    stdout: commentLines(comments),
  };
}

// gh's reply to posting a new comment on issue `n`: the id GitHub gave it,
// which the ops reply's commentIds carries.
/** @param {number} n @param {number} id @returns {GhReply} */
function postedCommentReply(n, id) {
  return { when: `issues/${n}/comments -f`, stdout: `${id}\n` };
}

/** @type {GhReply} */
const labelsReply = {
  when: "label list",
  stdout: JSON.stringify(labelNames.map((name) => ({ name }))),
};

// Preserve the CLI fixture's default account and four-argument call sites.
/** @param {number} id @param {string} lane @param {string} sweep @param {string} at @returns {object} */
function claimComment(id, lane, sweep, at) {
  return claimWireComment({ id, lane, sweep, login: ACCOUNT, at });
}

/** @param {number} n @returns {string} */
function worktree(n) {
  return path.join(root, "work", "o__r", `issue-${n}`);
}

/** @param {number} n @returns {string} */
function runDir(n) {
  return path.join(root, "runs", "o__r", `issue-${n}`);
}

export {
  ACCOUNT,
  ALLOWED,
  askOps,
  CONFIG,
  claimComment,
  commentsReply,
  configWith,
  effects,
  fakeGh,
  issueComment,
  labelsReply,
  loseOwnership,
  postedCommentReply,
  publicConfigOf,
  reply,
  requireGhReplies,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  timeless,
  worktree,
  writes,
};
