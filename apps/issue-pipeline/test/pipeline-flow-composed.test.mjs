// @ts-check
// The two-buddy task chain composed through the installed caller (#186,
// #180): Implementation, then Hippy's Sync once the target moves, fresh
// Hippy Hardening, read-only Lawd Integration and Security, an exact-head
// fast-forward Land and Completion. Every job starts through
// caller-jobs.mjs in one run folder, and each task request a job prints is
// relayed exactly as printed. The built job, ops and caller run for real
// against a local Git origin, the stateful fake GitHub with a development
// and a landing account, and the scripted fake pi.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";
import { ghAccountCalls } from "./fake-pipeline-flow-gh.mjs";
import { nativeTargetUpdates } from "./fake-pipeline-flow-gh-native.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import {
  callerJob,
  callerStatus,
  stopJobs,
} from "./pipeline-flow-run-test-kit.mjs";
import {
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import {
  BASE,
  bareGit,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";

const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
const TARGET = `refs/heads/${BASE}`;
const LAWD = "bot";
const DEV = "dev-bot";
const RECORD = "<!-- agent-pipeline:task-result";
const HARDENED = "Hello, polite world!";
// gh calls the development account may make: its login check and PR writes.
const DEV_PR_WRITES = new Set(["create", "edit", "reopen", "ready"]);
// The merge stage's retired synchronization, which no job may ask for.
const HIDDEN_SYNC = new Set(["sync-base", "finish-sync"]);

/** @type {import("./pipeline-flow-test-kit.mjs").Flow} */
let flow;
/** @type {string} the caller's run folder */
let run;
/** @type {string} the target commit T the Sync rebases onto */
let moved;
/** @type {string} R, the implemented revision */
let implemented;
/** @type {any[]} every caller step: its job's line and what it saw */
const steps = [];

before(() => {
  flow = setUpFlow();
  observeOps(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [
      implementorTurn("Hello, world!", "Greet visitors"),
      {
        files: { "repo/greet.txt": `${HARDENED}\n` },
        commits: [["-am", "Harden the greeting"]],
        output: { outcome: "done", summary: "Hardened the greeting" },
      },
    ],
    reviewer: [securityTurn()],
  });
  run = fs.mkdtempSync(path.join(flow.tmp, "caller-run-"));
  fs.writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({ maxJobs: 1, maxAttempts: 2 }),
  );
});
after(() => stopJobs(flow));

/** @returns {any[]} every op the flow ran, none before its first */
function trace() {
  if (!fs.existsSync(path.join(flow.root, "ops-trace.jsonl"))) {
    return [];
  }
  return opsTrace(flow);
}

/** @returns {any[]} every pi start */
function starts() {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

/**
 * Starts `stage` through the caller, with a task request when given, and
 * keeps what the job saw and changed.
 * @param {string} stage @param {{ task: string, binding: unknown }} [request]
 */
async function step(stage, request) {
  /** @type {string[]} */
  const extra = [];
  if (request !== undefined) {
    extra.push(
      "--task",
      request.task.toLowerCase(),
      "--binding",
      JSON.stringify(request.binding),
    );
  }
  const counts = {
    sessions: starts().length,
    ops: trace().length,
    accounts: ghAccountCalls(flow.ghDir).length,
  };
  const { launch, line } = await callerJob(flow, run, stage, extra);
  const taken = {
    stage,
    extra,
    line,
    launch,
    ...counts,
    branch: refIn(flow.origin, BRANCH),
    target: refIn(flow.origin, TARGET),
  };
  steps.push(taken);
  return taken;
}

/** @param {any} at @returns {string[]} the ops the job ran */
function opsOf(at) {
  const next = steps[steps.indexOf(at) + 1];
  return trace()
    .slice(at.ops, next?.ops)
    .map(({ request }) => request.op);
}

/**
 * Commits `files` onto the target on the origin, as another landed change
 * would, and returns the new target commit.
 * @param {Record<string, string>} files
 */
function advanceTarget(files) {
  const dir = fs.mkdtempSync(path.join(flow.tmp, "elsewhere-"));
  /** @param {string[]} args */
  function git(args) {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Elsewhere",
        "-c",
        "user.email=elsewhere@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }
  git(["clone", "--quiet", "--branch", BASE, flow.origin, "."]);
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), text);
    git(["add", file]);
  }
  git(["commit", "--quiet", "-m", "Another change lands"]);
  git(["push", "--quiet", "origin", `HEAD:${TARGET}`]);
  return git(["rev-parse", "HEAD"]);
}

/** @returns {any[]} the task-result records GitHub holds, parsed, with their author */
function records() {
  return readWorld(flow.ghDir)
    .comments.filter(({ body }) => body.startsWith(RECORD))
    .map(({ body, login }) => ({
      login,
      ...JSON.parse(body.slice(RECORD.length, -"\n-->".length)),
    }));
}

test("Implementation writes R as Hippy through the caller", async () => {
  const { line } = await step("implement");
  assert.equal(line.end, "next");
  implemented = String(refIn(flow.origin, BRANCH));
  assert.equal(savedState(readWorld(flow.ghDir)).stage, "review");
});

test("a target that moved past R makes review request Hippy's Sync of exactly R onto T, before any Hardening session", async () => {
  moved = advanceTarget({ "NEWS.md": "Greetings changed.\n" });
  const at = await step("review");
  assert.deepEqual(at.launch.argv.slice(-2), ["--hardening-buddy", "hippy"]);
  assert.equal(at.line.end, "wait");
  assert.equal(at.line.request.task, "Sync");
  assert.deepEqual(at.line.request.binding.revision.code, implemented);
  assert.equal(at.line.request.binding.target.commit, moved);
  assert.equal(starts().length, at.sessions, "no session hardened a stale R");
  assert.equal(at.branch, implemented);
});

test("Hippy's Sync rebases R onto exactly T as R′, pushes only the branch, and Lawd records its result", async () => {
  const [{ line: asked }] = steps.slice(-1);
  const at = await step("review", asked.request);
  assert.equal(at.line.end, "next");
  assert.equal(at.line.task.task, "Sync");
  assert.equal(at.line.task.verdict, "passed");
  assert.deepEqual(at.line.task.binding, asked.request.binding);
  const synced = String(at.branch);
  assert.equal(at.line.task.produced, synced);
  assert.notEqual(synced, implemented);
  bareGit(flow.origin, ["merge-base", "--is-ancestor", moved, synced]);
  assert.equal(at.target, moved, "Sync never writes the target");
  assert.equal(starts().length, at.sessions, "a clean Sync needs no resolver");
  const state = savedState(readWorld(flow.ghDir));
  assert.equal(state.stage, "review");
  assert.equal(state.headSha, synced);
  assert.equal(state.hardened, null);
  assert.equal(
    at.launch.receipt.endsWith(path.join("issue-7", "sync-1")),
    true,
  );
  const ops = opsOf(at);
  assert.ok(ops.includes("sync-task"));
  assert.equal(
    ops.includes("exit-push"),
    false,
    "a task job never exit-pushes",
  );
});

test("fresh Hippy Hardening of R′ runs as the Developer in a new session, and only Lawd records its result", async () => {
  const at = await step("review");
  assert.equal(at.line.end, "next");
  const [implementation] = starts();
  const hardening = starts().at(-1);
  assert.equal(starts().length, at.sessions + 1);
  assert.equal(hardening.role, "implementor");
  assert.equal(hardening.fresh, true);
  assert.notEqual(hardening.sessionFile, implementation.sessionFile);
  assert.equal(hardening.ghToken, null);
  const state = savedState(readWorld(flow.ghDir));
  assert.equal(state.stage, "merge");
  assert.equal(state.hardened.code, at.branch);
  assert.equal(state.hardenedTarget.sha, moved);
  assert.equal(
    bareGit(flow.origin, ["show", `${at.branch}:greet.txt`]),
    HARDENED,
  );
});

test("merge requests read-only Integration of exactly R′ on T instead of checking or syncing itself", async () => {
  const at = await step("merge");
  assert.equal(at.line.end, "wait");
  assert.equal(at.line.request.task, "Integration");
  assert.equal(at.line.request.binding.revision.code, at.branch);
  assert.equal(at.line.request.binding.target.commit, moved);
  assert.equal(starts().length, at.sessions);
  assert.deepEqual(
    opsOf(at).filter((op) =>
      ["verify", "merge", "integration-task"].includes(op),
    ),
    [],
  );
});

test("Lawd's Integration checks R′ on T as a reader: no session, branch, target or PR effect, only its records", async () => {
  const [{ line: asked, branch }] = steps.slice(-1);
  const at = await step("merge", asked.request);
  assert.equal(at.line.end, "next");
  assert.equal(at.line.task.task, "Integration");
  assert.equal(at.line.task.verdict, "passed");
  assert.equal(starts().length, at.sessions, "Integration runs no model");
  assert.equal(at.branch, branch);
  assert.equal(at.target, moved);
  const writes = ghAccountCalls(flow.ghDir)
    .slice(at.accounts)
    .filter(({ args }) => args[0] === "pr" && args[1] !== "view");
  assert.deepEqual(writes, []);
  const boundary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(flow.root, "job.mjs"),
        "--config",
        flow.config,
        "--issue",
        String(ISSUE),
        "--branch",
        `agent/issue-${ISSUE}`,
        "--stage",
        "merge",
        "--print-boundary",
        ...at.extra,
      ],
      { env: flow.env, encoding: "utf8" },
    ),
  );
  assert.equal(boundary.role, "reader");
  assert.deepEqual(boundary.access, { repo: "read" });
  assert.equal(savedState(readWorld(flow.ghDir)).verifiedSha, branch);
});

test("merge runs read-only Security, then lands exactly the hardened revision by fast-forward and completes", async () => {
  const at = await step("merge");
  assert.equal(at.line.end, "next");
  const security = starts().at(-1);
  assert.equal(starts().length, at.sessions + 1);
  assert.equal(security.role, "reviewer");
  assert.equal(security.commitScope, false);
  assert.equal(security.ghToken, null);
  const [{ branch: landed }] = steps.slice(-2);
  assert.equal(at.target, landed, "the target is exactly R′");
  const world = readWorld(flow.ghDir);
  // The other change's push moved the target to T; Land is the one write
  // after it: T to exactly R″, by fast-forward.
  assert.deepEqual(nativeTargetUpdates(world).slice(-1), [
    { origin: flow.origin, ref: TARGET, old: moved, head: landed },
  ]);
  bareGit(flow.origin, ["merge-base", "--is-ancestor", moved, landed]);
  const state = savedState(world);
  assert.equal(state.stage, "done");
  assert.equal(state.merged.code, landed);
  assert.equal(world.issues[0]?.state, "closed");
  /** @type {any[]} */
  const ops = trace().slice(at.ops);
  const merge = ops.find(({ request }) => request.op === "merge");
  assert.equal(merge?.request.binding.task, "Land");
  assert.equal(merge?.request.binding.revision.code, landed);
  assert.equal(merge?.request.binding.target.commit, moved);
  const confirm = ops.find(({ request }) => request.op === "confirm-merged");
  assert.equal(confirm?.request.binding.task, "Land");
  assert.deepEqual(
    ops.filter(({ request }) => request.op === "verify"),
    [],
    "no suite runs again after Integration",
  );
});

test("Lawd alone recorded every result, in chain order: Sync of R, then every check of Hardening's R″ on T", () => {
  const all = records();
  assert.deepEqual([...new Set(all.map(({ login }) => login))], [LAWD]);
  const synced = steps.find(({ line }) => line.task?.task === "Sync")?.branch;
  // Hardening's own commit made R″ from Sync's R′: every later task binds it.
  const hardened = savedState(readWorld(flow.ghDir)).merged.code;
  assert.notEqual(hardened, synced);
  assert.deepEqual(
    all.map((record) => [
      record.binding.task,
      record.kind,
      record.verdict ?? null,
      record.binding.revision.code,
      record.binding.target.commit,
    ]),
    [
      ["Sync", "attempt", null, implemented, moved],
      ["Sync", "result", "passed", implemented, moved],
      ["Hardening", "attempt", null, hardened, moved],
      ["Hardening", "result", "passed", hardened, moved],
      ["Integration", "attempt", null, hardened, moved],
      ["Integration", "result", "passed", hardened, moved],
      ["Security", "attempt", null, hardened, moved],
      ["Security", "result", "passed", hardened, moved],
      ["Land", "attempt", null, hardened, moved],
      ["Land", "result", "passed", hardened, moved],
    ],
  );
  const land = all.at(-1);
  assert.equal(land.receipt.produced.code, hardened);
  const sync = all.find(
    (record) => record.binding.task === "Sync" && record.kind === "result",
  );
  assert.equal(sync.receipt.produced.code, synced);
});

test("the development account wrote only the PR and its branch, no job asked for the retired merge synchronization, and the caller reports each task completed", () => {
  const devWrites = ghAccountCalls(flow.ghDir).filter(
    ({ login, args }) =>
      login === DEV && !(args[0] === "api" && args[1] === "user"),
  );
  // Its PR writes, and Completion's deletion of the issue's own branch.
  assert.deepEqual(
    devWrites.filter(
      ({ args }) =>
        !(
          (args[0] === "pr" && DEV_PR_WRITES.has(String(args[1]))) ||
          args.join(" ") === `api -X DELETE repos/o/r/git/${BRANCH} --silent`
        ),
    ),
    [],
  );
  const ran = trace().map(({ request }) => request.op);
  assert.deepEqual(
    ran.filter((op) => HIDDEN_SYNC.has(op)),
    [],
  );
  const reports = callerStatus(flow, run);
  assert.deepEqual(
    reports.map(({ stage, task, result, taskState }) => [
      stage,
      task ?? null,
      result.end,
      taskState,
    ]),
    [
      ["implement", null, "next", null],
      ["review", null, "wait", null],
      ["review", "sync", "next", "completed"],
      ["review", null, "next", null],
      ["merge", null, "wait", null],
      ["merge", "integration", "next", "completed"],
      ["merge", null, "next", null],
    ],
  );
  assert.deepEqual(
    reports
      .filter(({ request }) => request !== null)
      .map(({ request }) => request.task),
    ["Sync", "Integration"],
  );
});
