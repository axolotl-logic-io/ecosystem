// The two-buddy chain driven only by assignment sweeps (#121): the grantor
// assigns Hippy, then Lawd, and each sweep starts whatever the issue's
// saved stage or last task request calls for. No stage or task is started
// by hand. Implementation, Hippy's Sync once the target moves, fresh Hippy
// Hardening, Lawd's read-only Integration and Security, the exact-head
// fast-forward Land and Completion follow. The local caches are deleted
// mid-chain, and the chain carries on from GitHub's records. The installed
// sweep, launcher, job and ops run for real against the fake GitHub, a
// local origin and fake pi.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { SweepLine } from "./assignment-test-kit.ts";
import {
  GRANTOR,
  HIPPY,
  LAWD,
  optIn,
  runFolder,
  startedJobs,
  sweep,
} from "./assignment-test-kit.ts";
import { ghAccountCalls } from "./fake-pipeline-flow-gh.ts";
import { assignIssue } from "./fake-pipeline-flow-gh-assignments.ts";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import {
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import {
  advanceTarget,
  BASE,
  ISSUE,
  refIn,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.ts";

const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
const TARGET = `refs/heads/${BASE}`;
const RECORD = "<!-- agent-pipeline:task-result";
const WRITE_FLAG = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/u;
const DEV_PR_WRITES = new Set(["create", "edit", "reopen", "ready"]);
// The most sweeps the chain may take.
const MAX_SWEEPS = 12;

// What the test reads from a task-result record GitHub holds.
interface SeenRecord {
  login: string;
  kind: string;
  binding: {
    task: string;
    target: { commit: string };
    revision: { code: string };
  };
}

let flow: Flow;
let run: string;
// each job a sweep started
const started: { work: string; end: string | undefined }[] = [];

// Sweeps once and waits for what it started; gives the issue's decision.
async function sweepOnce(): Promise<SweepLine | undefined> {
  const decisions = sweep(flow, run);
  const jobs = await startedJobs(flow, decisions);
  for (const { launch, line } of jobs) {
    started.push({ work: launch.task ?? launch.stage, end: line?.end });
  }
  return decisions.find((each) => each.issue === ISSUE);
}

// Sweeps until a sweep starts nothing, at most `limit` times; gives the
// last decision.
async function sweepUntilHeld(limit: number): Promise<SweepLine | undefined> {
  const decision = await sweepOnce();
  if (decision?.start === undefined || limit <= 1) {
    return decision;
  }
  return await sweepUntilHeld(limit - 1);
}

// Returns whether a gh call writes
function isWrite(args: readonly string[]): boolean {
  if (args[0] === "api") {
    return args.some((arg) => WRITE_FLAG.test(arg));
  }
  return !["list", "view", "checks"].includes(String(args[1]));
}

// Returns the task-result records GitHub holds, with their author
function records(): SeenRecord[] {
  return readWorld(flow.ghDir)
    .comments.filter(({ body }) => body.startsWith(RECORD))
    .map(({ body, login }) => ({
      login,
      ...JSON.parse(body.slice(RECORD.length, -"\n-->".length)),
    }));
}

test("sweeps alone carry an assigned issue from Implementation to Completion, rebuilding from GitHub after the caches go", async () => {
  flow = setUpFlow();
  optIn(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [
      implementorTurn("Hello, world!", "Greet visitors"),
      implementorTurn("Hello, polite world!", "Harden the greeting"),
    ],
    reviewer: [securityTurn()],
  });
  run = runFolder(flow, { maxJobs: 1, maxAttempts: 2 });
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);

  assert.equal((await sweepOnce())?.start?.stage, "implement");
  const implemented = refIn(flow.origin, BRANCH);
  const moved = advanceTarget(flow, { "NEWS.md": "Greetings changed.\n" });
  // The disposable caches go; runs/ is evidence and stays.
  fs.rmSync(path.join(flow.root, "clones", SLUG), { recursive: true });
  fs.rmSync(path.join(flow.root, "work", SLUG), { recursive: true });

  const handedOver = await sweepUntilHeld(MAX_SWEEPS);
  assert.equal(
    handedOver?.hold,
    `merge is ${LAWD}'s work, and ${LAWD} isn't assigned`,
  );
  assert.equal(savedState(readWorld(flow.ghDir)).stage, "merge");
  assignIssue(flow.ghDir, ISSUE, LAWD, GRANTOR);
  await sweepUntilHeld(MAX_SWEEPS);

  assert.deepEqual(started, [
    { work: "implement", end: "next" },
    { work: "review", end: "wait" },
    { work: "sync", end: "next" },
    { work: "review", end: "next" },
    { work: "merge", end: "wait" },
    { work: "integration", end: "next" },
    { work: "merge", end: "next" },
  ]);
  const world = readWorld(flow.ghDir);
  const state = savedState(world);
  assert.equal(state.stage, "done");
  assert.equal(world.issues[0]?.state, "closed");
  const landed = refIn(flow.origin, TARGET);
  assert.equal(state.merged?.code, landed);
  assert.notEqual(landed, implemented);
  assert.deepEqual(
    [...new Set(records().map(({ login }) => login))],
    [LAWD],
    "only Lawd records results",
  );
  const [, , ...chain] = records();
  assert.deepEqual(
    chain.map((record) => [
      record.binding.task,
      record.kind,
      record.binding.target.commit,
    ]),
    [
      ["Sync", "attempt", moved],
      ["Sync", "result", moved],
      ["Hardening", "attempt", moved],
      ["Hardening", "result", moved],
      ["Integration", "attempt", moved],
      ["Integration", "result", moved],
      ["Security", "attempt", moved],
      ["Security", "result", moved],
      ["Land", "attempt", moved],
      ["Land", "result", moved],
    ],
  );
  assert.ok(
    chain.slice(2).every((record) => record.binding.revision.code === landed),
  );
  const devWrites = ghAccountCalls(flow.ghDir)
    .filter(({ login }) => login === HIPPY)
    .map(({ args }) => args)
    .filter((args) => isWrite(args))
    .filter(
      (args) =>
        !(args[0] === "pr" && DEV_PR_WRITES.has(String(args[1]))) &&
        args.join(" ") !== `api -X DELETE repos/o/r/git/${BRANCH} --silent`,
    );
  assert.deepEqual(devWrites, [], "Hippy wrote only its PR and its branch");
});
