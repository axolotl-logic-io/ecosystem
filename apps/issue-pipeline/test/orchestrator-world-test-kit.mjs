// @ts-check
// Shared setup for the tests that run the orchestrator's queue and tick
// in-process (#234): a pipeline root with a bare origin and a config, the fake
// gh answering the sweep's calls, and the issue rows, state comments and
// job.json files the queue reads.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { StatusFile } from "../src/job/status.ts" */

const ACCOUNT = "bot";
const ALLOWED = "alice";
// The tick's clock, which the leases and job times are written against.
const NOW = new Date("2026-10-15T10:00:00.000Z");
const MINUTE_MS = 60_000;
// Issue n was opened ISSUE_SPAN - n minutes before the tick.
const ISSUE_SPAN = 1000;
// A process that is alive but not the test's own: signal 0 to it fails with
// EPERM unless the test runs as root, when it succeeds.
const OTHERS_PID = 1;
const PIPELINE_LABELS = [
  "agent:working",
  "agent:needs-info",
  "agent:split",
  "agent:merged",
];

const root = fs.mkdtempSync("/tmp/issue-pipeline-orchestrator-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// Environment variables are named by strings, as src/process.ts takes them.
Object.assign(process.env, Object.fromEntries([["ISSUE_PIPELINE_ROOT", root]]));

/** @param {string} command @returns {string} */
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

sh(
  `cd ${root} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null; cd seed && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m base && git push -q origin HEAD:integration`,
);

const fakeGh = installFakeGh();
const { STOPS } = await import("../src/stops.ts");
const { loadConfig, paths } = await import("../src/config.ts");
const labelNames = [
  ...PIPELINE_LABELS,
  ...STOPS.map((stop) => stop.label.name),
];

// Writes a config with `extra` over the base settings and returns its path.
/** @param {object} extra @returns {string} */
function configWith(extra) {
  const file = path.join(root, `config-${fs.readdirSync(root).length}.json`);
  const base = {
    repo: "o/r",
    account: ACCOUNT,
    allowedUsers: [ALLOWED],
    cloneUrl: path.join(root, "origin.git"),
    baseBranch: "integration",
    claimWaitSeconds: [0, 0],
    commands: { test: "true" },
  };
  fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }));
  return file;
}

const CONFIG = configWith({});
const cfg = loadConfig(CONFIG);

/**
 * One open issue: its number, labels and body, its saved state (none when
 * left out), and how many times the queue reads its comments (twice for an
 * agent:working issue, whose lease classify reads again).
 * @typedef {{ number: number, labels?: string[], body?: string, state?: object, reads?: number }} OpenIssue
 */

// Older issues have lower numbers.
/** @param {number} number @returns {string} */
function createdAt(number) {
  return new Date(
    NOW.getTime() - (ISSUE_SPAN - number) * MINUTE_MS,
  ).toISOString();
}

/** @param {OpenIssue} issue @returns {object} */
function row({ number, labels = [], body = "" }) {
  const named = labels.map((name) => ({ name }));
  const author = { login: ALLOWED };
  return {
    number,
    title: `Issue ${number}`,
    author,
    labels: named,
    createdAt: createdAt(number),
    body,
  };
}

/** @param {object} state @returns {object} */
function stateComment(state) {
  const body = `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
  const at = NOW.toISOString();
  return githubComment({
    id: 1,
    body,
    login: ACCOUNT,
    created: at,
    updated: at,
  });
}

/** @param {OpenIssue} issue @returns {GhReply[]} */
function commentReplies(issue) {
  /** @type {object[]} */
  const comments = [];
  if (issue.state !== undefined) {
    comments.push(stateComment(issue.state));
  }
  const one = {
    when: `issues/${issue.number}/comments?per_page`,
    stdout: commentLines(comments),
  };
  return Array.from({ length: issue.reads ?? 1 }, () => one);
}

// Queues gh's answers to one read of the queue holding `issues`.
/** @param {readonly OpenIssue[]} issues @returns {void} */
function openWith(issues) {
  fakeGh.reply([
    { when: "api user", stdout: `${ACCOUNT}\n` },
    {
      when: "label list",
      stdout: JSON.stringify(labelNames.map((name) => ({ name }))),
    },
    { when: "issue list", stdout: JSON.stringify(issues.map(row)) },
    ...issues.flatMap(commentReplies),
  ]);
}

// A lease held by `lane` as of the tick, in a state comment's form.
/** @param {string} lane @returns {object} */
function leaseOf(lane) {
  return { lane, sweepId: "x", at: NOW.toISOString() };
}

// Writes issue `issue`'s job.json: a `stage` job run by `pid`, ended or not
// (`outcome` overrides `ended`), whose one launch, a session unless `kind`
// says ops, spent `tokens` input tokens by the tick and was last heard from
// `silentMinutes` before it, and whose last `failures.count` calls of
// `failures.tool` failed, the last with `failures.error`, with a token budget
// of `tokenBudget`, a live context of `contextTokens` tokens and the launch's
// own `launchOutcome`.
/** @typedef {{ count: number, tool: string, error: string }} Failures */
/** @typedef {{ issue: number, stage: string, pid: number, ended?: boolean, tokens?: number, outcome?: StatusFile["outcome"], kind?: "session" | "ops", silentMinutes?: number, failures?: Failures, tokenBudget?: number | null, contextTokens?: number, launchOutcome?: LaunchOutcome }} JobFacts */
/** @typedef {StatusFile["launches"][number]["outcome"]} LaunchOutcome */
/** @param {JobFacts} job @returns {StatusFile} */
function writeJob({
  issue,
  stage,
  pid,
  ended = false,
  tokens = 0,
  outcome,
  kind = "session",
  silentMinutes = 0,
  failures = { count: 0, tool: "", error: "" },
  tokenBudget = null,
  contextTokens = 0,
  launchOutcome = null,
}) {
  const at = new Date(NOW.getTime() - silentMinutes * MINUTE_MS).toISOString();
  /** @type {StatusFile} */
  const status = {
    version: 1,
    pid,
    issue,
    stage,
    lane: "orchestrator",
    startedAt: at,
    socket: "/tmp/s.sock",
    outcome: null,
    launches: [
      {
        key: `i${issue}-${stage}-1`,
        kind,
        pid,
        session: null,
        startedAt: at,
        lastEventAt: at,
        toolFailures: failures.count,
        lastToolFailure: lastFailure(failures),
        usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
        tokenBudget,
        contextTokens,
        peakContext: 0,
        contextStop: null,
        resumed: false,
        outcome: launchOutcome,
      },
    ],
  };
  if (ended) {
    status.outcome = { kind: "finished" };
  }
  if (outcome !== undefined) {
    status.outcome = outcome;
  }
  const dir = paths.runDir(cfg, issue);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(status));
  return status;
}

/** @param {Failures} failures @returns {{ tool: string, error: string } | null} */
function lastFailure({ count, tool, error }) {
  if (count === 0) {
    return null;
  }
  return { tool, error };
}

// A pid whose process has exited and been reaped.
/** @returns {number} */
function deadPid() {
  const { pid } = spawnSync("true");
  if (pid === undefined) {
    throw new Error("true did not start");
  }
  return pid;
}

// A file in the config's runs folder, such as orchestrator.log.
/** @param {string} name @returns {string} */
function runFile(name) {
  return path.join(root, "runs", cfg.slug, name);
}

export {
  CONFIG,
  cfg,
  configWith,
  deadPid,
  fakeGh,
  leaseOf,
  MINUTE_MS,
  NOW,
  OTHERS_PID,
  openWith,
  root,
  runFile,
  writeJob,
};
