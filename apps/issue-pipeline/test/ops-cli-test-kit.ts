// The harness for the ops CLI tests (test/ops-*.test.ts): a temporary
// pipeline root with a bare origin on `integration`, a config pointing at it,
// a fake gh first on PATH, and askOps(), which sends one request to
// src/ops.ts as the workflow frames it. Times in replies and gh writes are
// replaced with TIME, so no assertion depends on the clock.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "./credentials-test-kit.ts";
import type { GhReply } from "./fake-gh.ts";
import {
  claimComment as claimWireComment,
  commentLines,
  githubComment,
  installFakeGh,
} from "./fake-gh.ts";
import { RELEASED_RECEIPT } from "./fake-ownership.ts";
import type { GhEffect } from "./gh-effects-test-kit.ts";
import { effectsOf } from "./gh-effects-test-kit.ts";
import { runOps, setEnv } from "./ops-run-test-kit.ts";

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

function sh(command: string): string {
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
const pipelineRoot: typeof import("../src/pipeline-root.ts") = await import(
  "../src/pipeline-root.ts"
);
if (pipelineRoot.ROOT !== root || pipelineRoot.HOME !== root) {
  throw new Error(
    "the pipeline root isn't the ops CLI tests' temporary folder",
  );
}
const fakeGh = installFakeGh();
const requireGhReplies: () => void = fakeGh.requireReplies;
const { STOPS }: typeof import("../src/stops.ts") = await import(
  "../src/stops.ts"
);
const { ghIsRead }: typeof import("../src/github.ts") = await import(
  "../src/github.ts"
);
// The config as a sweep reports it. config.ts is outside #183's move.
const { loadConfig, publicConfig }: typeof import("../src/config.ts") =
  await import("../src/config.ts");
const labelNames: string[] = [
  ...ALL_LABELS,
  ...STOPS.map((stop) => stop.label.name),
];

// Writes a config with `extra` over the base settings and returns its path.
function configWith(extra: object): string {
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

function publicConfigOf(file: string): object {
  return publicConfig(loadConfig(file));
}

// `text` with its times replaced by TIME, as replies and writes are.
function timeless(text: string): string {
  return text.replace(ISO_TIME, TIME);
}

// The reply to `request`, sent bound with the base config unless it names
// one.
function askOps(request: object, unbound = false): unknown {
  const stdout = runOps({ config: CONFIG, request, root, home: root, unbound });
  return JSON.parse(timeless(JSON.stringify(JSON.parse(stdout))));
}

// Queues gh's replies, and forgets earlier calls.
function reply(replies: readonly GhReply[]): void {
  fakeGh.reply(replies);
}

// The calls that change GitHub, in order, with times replaced: what a test
// checks for GitHub-visible effects, whatever reads came between them.
function writes(): string[][] {
  return fakeGh.writes(ghIsRead).map((args) => args.map(timeless));
}

// What those writes show on GitHub (see gh-effects-test-kit.ts).
function effects(): GhEffect[] {
  return effectsOf(writes());
}

// A comment as listComments reads it.
function issueComment(
  id: number,
  body: string,
  login: string = ACCOUNT,
  at = "2026-10-15T01:00:00Z",
): object {
  return githubComment({ id, body, login, created: at, updated: at });
}

function stateComment(id: number, state: object): object {
  return issueComment(
    id,
    `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
  );
}

// A state comment as an earlier, released run saved it, with that run's
// receipt (fake-ownership.ts), so a bound claim can resume it.
function savedStateComment(id: number, state: object): object {
  return stateComment(id, { ...state, execution: RELEASED_RECEIPT });
}

// gh's reply to listComments for issue `n`.
function commentsReply(n: number, comments: readonly unknown[]): GhReply {
  return {
    when: `issues/${n}/comments?per_page`,
    stdout: commentLines(comments),
  };
}

// gh's reply to posting a new comment on issue `n`: the id GitHub gave it,
// which the ops reply's commentIds carries.
function postedCommentReply(n: number, id: number): GhReply {
  return { when: `issues/${n}/comments -f`, stdout: `${id}\n` };
}

const labelsReply: GhReply = {
  when: "label list",
  stdout: JSON.stringify(labelNames.map((name) => ({ name }))),
};

// Preserve the CLI fixture's default account and four-argument call sites.
function claimComment(
  id: number,
  lane: string,
  sweep: string,
  at: string,
): object {
  return claimWireComment({ id, lane, sweep, login: ACCOUNT, at });
}

function worktree(n: number): string {
  return path.join(root, "work", "o__r", `issue-${n}`);
}

function runDir(n: number): string {
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
  postedCommentReply,
  publicConfigOf,
  reply,
  requireGhReplies,
  root,
  runDir,
  savedStateComment,
  sh,
  stateComment,
  TIME,
  timeless,
  worktree,
  writes,
};
