// @ts-check
// Shared setup for the tests that run the orchestrator's tick in-process: a
// pipeline root with a bare origin and a config, the fake gh answering the
// queue's reads, the issues' comments (state, Gherkin, trusted and visitor
// comments) and job.json files the queue reads, and a tick whose spawn and
// process checks are recorded fakes, so no stage job or model runs. A test
// imports every src module through this kit, after it has set the pipeline
// root: a module loaded first would fix the installed root for the run, so

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { credentialConfig } from "../credentials-test-kit.mjs";
import { commentLines, githubComment, installFakeGh } from "../fake-gh.mjs";
import { isolatedRoot as root } from "../isolated-root-test-kit.mjs";

/** @import { GhReply } from "../fake-gh.mjs" */
/** @import { TickResult } from "../../src/orchestrator/tick.ts" */

const ACCOUNT = "bot";
const ALLOWED = "alice";
const VISITOR = "mallory";
// The tick's clock, which the leases and job times are written against.
const NOW = new Date("2026-10-15T10:00:00.000Z");
const MINUTE_MS = 60_000;
// How long before the tick a written job started, unless it says.
const JOB_AGE_MINUTES = 30;
const JOB_AGE_MS = JOB_AGE_MINUTES * MINUTE_MS;
// The pid the tick's first spawn gets; each later spawn gets the next.
const FIRST_SPAWN_PID = 50_001;
// Issue n was opened ISSUE_SPAN - n minutes before the tick.
const ISSUE_SPAN = 1000;
const STATE_ID_BASE = 1000;
const PIPELINE_LABELS = [
  "agent:working",
  "agent:needs-info",
  "agent:split",
  "agent:merged",
];

const seeded = spawnSync(
  "bash",
  [
    "-c",
    `cd ${root} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null; cd seed && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m base && git push -q origin HEAD:integration`,
  ],
  { encoding: "utf8" },
);
if (seeded.status !== 0) {
  throw new Error(`seeding origin failed: ${seeded.stderr}`);
}

/** @type {string[][]} */
const recordedSpawns = [];
const fakeGh = installFakeGh();
fakeGh.reply([
  { when: "api repos/o/r/collaborators/alice", stdout: "", keep: true },
]);
const { ghIsRead } = await import("../../src/github.ts");
const { STOPS } = await import("../../src/stops.ts");
const { loadConfig, paths } = await import("../../src/config.ts");
const { keyMark, signed } = await import("../../src/comments.ts");
const { gherkinBody } = await import("../../src/gherkin-comment.ts");
const { trustedInputsHash } = await import("../../src/issue-context.ts");
const { tick } = await import("../../src/orchestrator/tick.ts");
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
const cfg = loadConfig(CONFIG);

/**
 * One open issue: its number, labels, author and body, its saved state (none
 * when left out), and its other comments, oldest first.
 * @typedef {{ number: number, labels?: string[], author?: string, body?: string, state?: object, comments?: object[] }} OpenIssue
 */

/** @param {OpenIssue} issue @returns {{number: number, title: string, author: {login: string}, labels: {name: string}[], createdAt: string, body: string}} */
function row({ number, labels = [], body = "", author = ALLOWED }) {
  return {
    number,
    title: `Issue ${number}`,
    author: { login: author },
    labels: labels.map((name) => ({ name })),
    createdAt: new Date(
      NOW.getTime() - (ISSUE_SPAN - number) * MINUTE_MS,
    ).toISOString(),
    body,
  };
}

/** @param {number} id @param {string} login @param {string} body @returns {object} */
function commentBy(id, login, body) {
  const at = NOW.toISOString();
  return githubComment({ id, body, login, created: at, updated: at });
}

// A comment the pipeline wrote, signed by `role`, which isn't trusted input.
/** @param {number} id @param {string} role @param {string} body @returns {object} */
function pipelineComment(id, role, body) {
  return commentBy(id, ACCOUNT, signed({ role }, body));
}

// The pipeline's Gherkin comment on issue `number`, written from `inputs`.
/** @param {number} id @param {number} number @param {string} inputs @returns {object} */
function gherkinComment(id, number, inputs) {
  const text = {
    gherkin: "Feature: F\n  Scenario: S",
    assumptions: [],
  };
  const body = `${signed({ role: "author" }, gherkinBody(text, { rev: 1, inputs }))}\n${keyMark(number, "gherkin")}`;
  return commentBy(id, ACCOUNT, body);
}

// The trusted-inputs revision of issue `issue` with its `comments`.
/** @param {OpenIssue} issue @returns {string} */
function inputsOf(issue) {
  const comments =
    /** @type {import("../../src/comments.ts").IssueComment[]} */ (
      issue.comments ?? []
    );
  const { title } = row(issue);
  return trustedInputsHash(
    cfg,
    { title, body: issue.body ?? "", user: { login: issue.author ?? ALLOWED } },
    comments,
  );
}

// Issue `number`'s state comment, whose id is STATE_ID_BASE + number.
/** @param {number} number @param {object} state @returns {object} */
function stateComment(number, state) {
  const body = `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
  return commentBy(STATE_ID_BASE + number, ACCOUNT, body);
}

/** @param {OpenIssue} issue @returns {GhReply} */
function commentReply(issue) {
  /** @type {object[]} */
  const comments = [...(issue.comments ?? [])];
  if (issue.state !== undefined) {
    comments.unshift(stateComment(issue.number, issue.state));
  }
  return {
    when: `issues/${issue.number}/comments?per_page`,
    stdout: commentLines(comments),
    keep: true,
  };
}

// Queues gh's answers to the reads of the queue holding `issues`, then
// `others`, such as close-parent's reads.
/** @param {readonly OpenIssue[]} issues @param {readonly GhReply[]} [others] @returns {void} */
function openWith(issues, others = []) {
  fakeGh.reply([
    { when: "api user", stdout: `${ACCOUNT}\n`, keep: true },
    {
      when: "label list",
      stdout: JSON.stringify(labelNames.map((name) => ({ name }))),
      keep: true,
    },
    { when: "issue list", stdout: JSON.stringify(issues.map(row)) },
    ...others,
    ...issues.map(commentReply),
    { when: "api repos/o/r/collaborators/alice", stdout: "", keep: true },
  ]);
}

// A lease held by `lane` as of the tick, in a state comment's form.
/** @param {string} lane @returns {object} */
function leaseOf(lane) {
  return { lane, sweepId: "x", at: NOW.toISOString() };
}

// Writes issue `issue`'s job.json: a `stage` job run by `pid`, ended as
// `outcome` says (null: no outcome), of this pipeline unless
// `pipelineVersion` is left out by `legacy`.
/** @typedef {{ kind: "finished", rateLimited?: boolean, claimError?: string } | { kind: "stopped" } | { kind: "failed", error: string }} Outcome */
/** @typedef {{ issue: number, stage: string, pid: number, outcome?: Outcome | null, legacy?: boolean, startedAt?: string, endedAt?: string }} JobFacts */
/** @param {JobFacts} job @returns {void} */
function writeJob({
  issue,
  stage,
  pid,
  outcome = null,
  legacy = false,
  startedAt = new Date(NOW.getTime() - JOB_AGE_MS).toISOString(),
  endedAt,
}) {
  /** @type {{ pipelineVersion?: number, endedAt?: string } & Record<string, unknown>} */
  const status = {
    version: 1,
    pid,
    issue,
    stage,
    lane: "orchestrator",
    startedAt,
    socket: "/tmp/s.sock",
    outcome,
    launches: [],
  };
  if (!legacy) {
    status.pipelineVersion = 2;
  }
  if (endedAt !== undefined) {
    status.endedAt = endedAt;
  }
  const dir = paths.runDir(cfg, issue);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(status));
}

// A file in the config's runs folder, such as orchestrator.log.
/** @param {string} name @returns {string} */
function runFile(name) {
  return path.join(root, "runs", cfg.slug, name);
}

// The decision log's lines for issue `issue`, as `stage action reason`.
/** @param {number} issue @returns {string[]} */
function loggedFor(issue) {
  if (!fs.existsSync(runFile("orchestrator.log"))) {
    return [];
  }
  return fs
    .readFileSync(runFile("orchestrator.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.issue === issue)
    .map(({ stage, action, reason }) => `${stage} ${action} ${reason}`);
}

// Clears what earlier ticks left: job.jsons, memory, starts, backoff, log.
/** @returns {void} */
function resetRuns() {
  fs.rmSync(path.join(root, "runs"), { recursive: true, force: true });
}

/**
 * One tick over the queue `openWith` set up, its processes faked: `live` are the pids that run, and each spawn gets the next
 * pid from FIRST_SPAWN_PID and is recorded as its argv.
 * @param {{ live?: readonly number[], at?: Date }} [run]
 * @returns {{ result: TickResult, spawned: string[][] }}
 */
function tickOver(run = {}) {
  recordedSpawns.length = 0;
  /** @type {string[][]} */
  const spawned = [];
  const live = new Set(run.live ?? []);
  const result = tick(cfg, {
    configPath: CONFIG,
    now: () => run.at ?? NOW,
    spawn: (argv) => {
      spawned.push([...argv]);
      recordedSpawns.push([...argv]);
      return FIRST_SPAWN_PID + spawned.length - 1;
    },
    alive: (pid) => live.has(pid),
  });
  return { result, spawned };
}

export {
  ALLOWED,
  CONFIG,
  cfg,
  commentBy,
  FIRST_SPAWN_PID,
  fakeGh,
  gherkinComment,
  ghIsRead,
  inputsOf,
  leaseOf,
  loggedFor,
  MINUTE_MS,
  NOW,
  openWith,
  pipelineComment,
  recordedSpawns,
  resetRuns,
  runFile,
  STATE_ID_BASE,
  stateComment,
  tickOver,
  VISITOR,
  writeJob,
};
