// @ts-check
// The task chain's safety through built jobs (#186): the legacy merge entry
// point never synchronizes, a hardened checkpoint saved before activation is
// never a Hardening result, a task request that isn't this issue's or this
// stage's is refused before any effect, and a Sync that stops on conflicts
// goes to Hippy's resolver, whose staged resolution lands as R′. Local Git,
// the stateful fake GitHub and the scripted fake pi stand in for the
// services; every effect is read from them.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { ghAccountCalls } from "./fake-pipeline-flow-gh.mjs";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { observeOps, opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { replaceState } from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, runTask, stopJobs } from "./pipeline-flow-run-test-kit.mjs";
import {
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  savedState,
  securityTurn,
} from "./pipeline-flow-script-test-kit.mjs";
import {
  advanceTarget,
  BASE,
  bareGit,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";
import { faultNextPush } from "./sync-task-test-kit.mjs";

const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
const TARGET = `refs/heads/${BASE}`;
const RECORD = "<!-- agent-pipeline:task-result";
const DIGEST_LENGTH = 64;
// Ops that write the branch, the target or a PR: none may run in a merge
// job that only requests Sync.
const WRITER_OPS = new Set([
  "sync-base",
  "finish-sync",
  "sync-task",
  "sync-task-finish",
  "push",
  "merge",
]);
const NOT_THIS_ISSUE = /binding is for o\/r#8, not o\/r#7/u;
const NOT_THIS_TASK = /--binding is for Integration, not the requested Sync/u;
const NOT_THIS_STAGE =
  /--task sync runs at --stage review or merge, not implement/u;
const NO_HARDENING_RESULT = /no passed Hardening task result/u;

/** @type {import("./pipeline-flow-test-kit.mjs").Flow[]} */
const flows = [];
after(() => {
  for (const flow of flows) {
    stopJobs(flow);
  }
});

/**
 * A flow implemented and hardened by the installed Reviewer, at merge.
 * @param {Record<string, unknown[]>} script
 */
function hardened(script) {
  const flow = setUpFlow();
  flows.push(flow);
  observeOps(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, script);
  for (const stage of ["implement", "review"]) {
    const { end } = runStage(flow, stage);
    if (end !== "next") {
      throw new Error(`${stage} ended ${end}`);
    }
  }
  return flow;
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function starts(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function records(flow) {
  return readWorld(flow.ghDir).comments.filter(({ body }) =>
    body.startsWith(RECORD),
  );
}

/**
 * The ops `flow` ran since `from`, by name.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {number} from
 */
function opsSince(flow, from) {
  return opsTrace(flow)
    .slice(from)
    .map(({ request }) => request.op);
}

test("merge never synchronizes a moved target itself: it returns the work to review, which requests Sync, with no branch, target or PR write", () => {
  const flow = hardened({
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    reviewer: [hardeningTurn()],
  });
  const head = refIn(flow.origin, BRANCH);
  const moved = advanceTarget(flow, { "NEWS.md": "Elsewhere.\n" });
  const ops = opsTrace(flow).length;
  const sessions = starts(flow).length;
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(savedState(readWorld(flow.ghDir)).stage, "review");
  // Nothing the merge job ran wrote the branch, the target or a PR.
  assert.deepEqual(
    opsSince(flow, ops).filter((op) => WRITER_OPS.has(op)),
    [],
  );
  assert.equal(refIn(flow.origin, BRANCH), head);
  const line = runStage(flow, "review");
  assert.equal(line.end, "wait");
  assert.equal(line.request.task, "Sync");
  assert.equal(line.request.binding.revision.code, head);
  assert.equal(line.request.binding.target.commit, moved);
  assert.equal(refIn(flow.origin, BRANCH), head);
  assert.equal(refIn(flow.origin, TARGET), moved);
  assert.equal(starts(flow).length, sessions, "no session ran");
  assert.deepEqual(
    opsSince(flow, ops).filter((op) => WRITER_OPS.has(op)),
    [],
  );
});

test("a target that moves before Integration refuses its stale binding with no attempt, and the Integration job requests Sync of the fresh one at merge", () => {
  const flow = hardened({
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    reviewer: [hardeningTurn()],
  });
  const head = refIn(flow.origin, BRANCH);
  const asked = runStage(flow, "merge");
  assert.equal(asked.request.task, "Integration");
  const moved = advanceTarget(flow, { "NEWS.md": "Elsewhere.\n" });
  const ops = opsTrace(flow).length;
  const stale = runTask(flow, "merge", asked.request);
  assert.equal(stale.end, "wait");
  assert.equal(stale.task.verdict, "refused");
  assert.equal(stale.task.run, null, "no attempt was recorded");
  assert.equal(stale.request.task, "Sync");
  assert.equal(stale.request.binding.revision.code, head);
  assert.equal(stale.request.binding.target.commit, moved);
  assert.deepEqual(
    opsSince(flow, ops).filter((op) => WRITER_OPS.has(op)),
    [],
  );
  assert.equal(
    records(flow).filter(({ body }) => body.includes('"Integration"')).length,
    0,
  );
  const synced = runTask(flow, "merge", stale.request);
  assert.equal(synced.end, "next");
  assert.equal(synced.task.verdict, "passed");
  const state = savedState(readWorld(flow.ghDir));
  assert.equal(state.stage, "review");
  assert.equal(state.hardened, null);
  assert.equal(state.headSha, refIn(flow.origin, BRANCH));
  bareGit(flow.origin, ["merge-base", "--is-ancestor", moved, state.headSha]);
  assert.equal(refIn(flow.origin, TARGET), moved);
});

test("a hardened checkpoint saved before activation is not a Hardening result: merge returns it to review, which hardens it afresh", () => {
  const flow = hardened({
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    reviewer: [hardeningTurn(), hardeningTurn(), hardeningTurn()],
  });
  const before = savedState(readWorld(flow.ghDir));
  assert.ok(before.hardened);
  // A pre-activation install hardened it: the checkpoint, and no record.
  withWorld(flow.ghDir, (world) => {
    world.comments = world.comments.filter(
      ({ body }) => !body.startsWith(RECORD),
    );
  });
  const sessions = starts(flow).length;
  const line = runStage(flow, "merge");
  assert.equal(line.end, "next");
  const returned = savedState(readWorld(flow.ghDir));
  assert.equal(returned.stage, "review");
  assert.equal(returned.hardened, null);
  assert.match(returned.log.join("\n"), NO_HARDENING_RESULT);
  assert.equal(starts(flow).length, sessions, "merge started no session");
  assert.deepEqual(records(flow), []);
  assert.equal(runStage(flow, "review").end, "next");
  assert.equal(starts(flow).length, sessions + 1, "a fresh Hardening ran");
  const kinds = records(flow).map(({ body }) => {
    const record = JSON.parse(body.slice(RECORD.length, -"\n-->".length));
    return [record.binding.task, record.kind];
  });
  assert.deepEqual(kinds, [
    ["Hardening", "attempt"],
    ["Hardening", "result"],
  ]);
  // The same at review: a saved checkpoint with no result for its revision
  // and target hardens afresh instead of going on to merge.
  withWorld(flow.ghDir, (world) => {
    world.comments = world.comments.filter(
      ({ body }) => !body.startsWith(RECORD),
    );
  });
  const checkpointed = savedState(readWorld(flow.ghDir));
  assert.ok(checkpointed.hardened);
  replaceState(flow, { ...checkpointed, stage: "review" });
  assert.equal(runStage(flow, "review").end, "next");
  assert.equal(starts(flow).length, sessions + 2, "another fresh Hardening");
  assert.equal(records(flow).length, 2);
});

test("maxSyncs still bounds Sync: a Sync past the issue's limit stops before any effect or record", () => {
  const flow = setUpFlow();
  flows.push(flow);
  observeOps(flow);
  const settings = JSON.parse(fs.readFileSync(flow.config, "utf8"));
  fs.writeFileSync(flow.config, JSON.stringify({ ...settings, maxSyncs: 0 }));
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
  });
  assert.equal(runStage(flow, "implement").end, "next");
  const head = refIn(flow.origin, BRANCH);
  advanceTarget(flow, { "NEWS.md": "Elsewhere.\n" });
  const asked = runStage(flow, "review");
  assert.equal(asked.request.task, "Sync");
  const ops = opsTrace(flow).length;
  const stopped = runTask(flow, "review", asked.request);
  assert.equal(stopped.end, "stop");
  assert.equal(stopped.task.verdict, "held");
  assert.equal(savedState(readWorld(flow.ghDir)).stopCode, "sync-limit");
  assert.equal(refIn(flow.origin, BRANCH), head);
  assert.deepEqual(
    opsSince(flow, ops).filter((op) => WRITER_OPS.has(op)),
    [],
  );
  assert.deepEqual(records(flow), []);
});

test("a task job refuses a binding for another issue or task, or a task at a stage it can't run at, before it claims or writes anything", () => {
  const flow = hardened({
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
    reviewer: [hardeningTurn()],
  });
  const head = String(refIn(flow.origin, BRANCH));
  const base = {
    repo: "o/r",
    workItem: ISSUE,
    task: "Sync",
    revision: {
      code: head,
      inputs: "b".repeat(DIGEST_LENGTH),
      policy: "c".repeat(DIGEST_LENGTH),
    },
    target: { branch: BASE, commit: String(refIn(flow.origin, TARGET)) },
  };
  const calls = ghAccountCalls(flow.ghDir).length;
  const state = JSON.stringify(savedState(readWorld(flow.ghDir)));
  const sessions = starts(flow).length;
  const cases = [
    {
      stage: "merge",
      task: "sync",
      binding: { ...base, workItem: 8 },
      refused: NOT_THIS_ISSUE,
    },
    {
      stage: "merge",
      task: "sync",
      binding: { ...base, task: "Integration" },
      refused: NOT_THIS_TASK,
    },
    {
      stage: "implement",
      task: "sync",
      binding: base,
      refused: NOT_THIS_STAGE,
    },
  ];
  for (const { stage, task, binding, refused } of cases) {
    assert.throws(() => runTask(flow, stage, { task, binding }), refused);
  }
  assert.equal(ghAccountCalls(flow.ghDir).length, calls, "no GitHub call");
  assert.equal(JSON.stringify(savedState(readWorld(flow.ghDir))), state);
  assert.equal(starts(flow).length, sessions);
  assert.equal(refIn(flow.origin, BRANCH), head);
  assert.deepEqual(
    records(flow).filter(({ body }) => body.includes('"Sync"')),
    [],
  );
});

test("a Sync that stops on conflicts goes to Hippy's resolver in a fresh Developer session, and its staged resolution lands as R′ containing T", () => {
  const flow = setUpFlow();
  flows.push(flow);
  observeOps(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [
      implementorTurn("Hello, world!", "Greet visitors"),
      {
        files: { "repo/greet.txt": "Hello, both worlds!\n" },
        stage: ["greet.txt"],
        output: {
          outcome: "conflict-resolved",
          summary: "Kept both greetings",
        },
      },
    ],
    reviewer: [hardeningTurn(), securityTurn()],
  });
  assert.equal(runStage(flow, "implement").end, "next");
  const implemented = String(refIn(flow.origin, BRANCH));
  const moved = advanceTarget(flow, { "greet.txt": "Hello, elsewhere!\n" });
  const asked = runStage(flow, "review");
  assert.equal(asked.end, "wait");
  assert.equal(asked.request.task, "Sync");
  const sessions = starts(flow).length;
  const synced = runTask(flow, "review", asked.request);
  assert.equal(synced.end, "next", JSON.stringify(synced));
  assert.equal(synced.task.verdict, "passed");
  const [implementation] = starts(flow);
  const resolver = starts(flow).at(-1);
  assert.equal(starts(flow).length, sessions + 1);
  assert.equal(resolver.role, "implementor");
  assert.equal(resolver.fresh, true);
  assert.notEqual(resolver.sessionFile, implementation.sessionFile);
  assert.equal(resolver.ghToken, null);
  const head = String(refIn(flow.origin, BRANCH));
  assert.equal(synced.task.produced, head);
  assert.notEqual(head, implemented);
  bareGit(flow.origin, ["merge-base", "--is-ancestor", moved, head]);
  assert.equal(
    bareGit(flow.origin, ["show", `${head}:greet.txt`]),
    "Hello, both worlds!",
  );
  assert.equal(
    refIn(flow.origin, TARGET),
    moved,
    "Sync never writes the target",
  );
  const state = savedState(readWorld(flow.ghDir));
  assert.equal(state.stage, "review");
  assert.equal(state.counts.conflictFixes, 1);
  assert.equal(state.counts.syncs, 1);
});

test("a Sync whose push is refused leaves its run unsettled, its job pushes nothing at exit, and the next Sync job settles it by reading", () => {
  const flow = setUpFlow();
  flows.push(flow);
  observeOps(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [implementorTurn("Hello, world!", "Greet visitors")],
  });
  assert.equal(runStage(flow, "implement").end, "next");
  const head = refIn(flow.origin, BRANCH);
  advanceTarget(flow, { "NEWS.md": "Elsewhere.\n" });
  const asked = runStage(flow, "review");
  const ops = opsTrace(flow).length;
  faultNextPush(flow, "refuse");
  const refused = runTask(flow, "review", asked.request);
  assert.equal(refused.end, "stop");
  assert.equal(refused.task.verdict, "unknown");
  // The rebased commits stay local: no exit push carries them out.
  assert.equal(refIn(flow.origin, BRANCH), head);
  assert.deepEqual(
    opsSince(flow, ops).filter((op) => op === "exit-push" || op === "push"),
    [],
  );
  replaceState(flow, {
    ...savedState(readWorld(flow.ghDir)),
    stage: "review",
    stoppedStage: null,
    stopCode: null,
  });
  const settled = runTask(flow, "review", asked.request);
  assert.equal(settled.task.verdict, "failed");
  assert.equal(refIn(flow.origin, BRANCH), head);
  const sync = records(flow).filter(({ body }) => body.includes('"Sync"'));
  assert.equal(sync.length, 2, "one attempt, settled once, never repeated");
});
