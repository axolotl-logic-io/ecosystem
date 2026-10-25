// The task-result ops' world (#183): the built ops.mjs in a full-flow root
// with the stateful fake GitHub and a real bare origin. rawOps() sends one
// request to a fresh ops process, as a buddy run or the caller would, and the
// helpers read what GitHub then shows: the issue's comments and the calls
// that changed it.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { ownedRequest } from "./fake-ownership.ts";
import { ghCalls, openIssue } from "./fake-pipeline-flow-gh.ts";
import {
  postComment,
  readWorld,
  withWorld,
} from "./fake-pipeline-flow-gh-world.ts";
import { isCoordinationWrite } from "./pipeline-flow-coordination-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { BASE, bareGit, setUpFlow } from "./pipeline-flow-test-kit.ts";

const RUN_MS = 60_000;
const MARK = "<!-- agent-pipeline:task-result\n";
const END = "\n-->";
const KIND = z.looseObject({ kind: z.string() });
const GH_WRITE = /^(?:-X|--method)$/u;
// The coordination records an owner's acquisition and release append
// (ownedRequest), which are no task record or state.
const COORDINATION = "<!-- agent-pipeline:coordination\n";

// Returns a new run identity
function runId(): string {
  return crypto.randomUUID();
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function taskWorld(issue: number): { flow: Flow; target: string } {
  const flow = setUpFlow();
  openIssue(flow.ghDir, {
    number: issue,
    title: "Task results",
    body: "Bind results to revisions.",
    login: "alice",
  });
  const target = bareGit(flow.origin, ["rev-parse", `refs/heads/${BASE}`]);
  return { flow, target };
}

// What a task-result read reports (docs/reference/task-results.md).
const STATUS = z.looseObject({
  status: z.enum([
    "passed",
    "refused",
    "unknown",
    "missing",
    "exhausted",
    "held",
  ]),
  attempts: z.number().int().optional(),
  budget: z.number().int().optional(),
  run: z.string().optional(),
  reason: z.string().optional(),
});
// One ops reply: a refusal's error, or a recording's attempt and status.
const REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  attempt: z.number().int().optional(),
  status: STATUS.optional(),
});

type TaskStatus = z.infer<typeof STATUS>;
type TaskReply = z.infer<typeof REPLY>;

// The flows whose next ops request loses its issue to a successor, and
// whether only after its first write (loseNextOwnership).
const losing: Map<Flow, boolean | number> = new Map();

// Makes `flow`'s next ops request lose its issue to a successor just after
// its ownership check, or with `afterWrite` just after its first write (or
// that many writes), so just before its next one (#169).
function loseNextOwnership(
  flow: Flow,
  { afterWrite = false }: { afterWrite?: boolean | number } = {},
): void {
  losing.set(flow, afterWrite);
}

// The raw reply of one fresh ops process to `request`.
function rawOps(flow: Flow, request: object): unknown {
  let lose: { bin: string; afterWrite: boolean | number } | undefined;
  const afterWrite = losing.get(flow);
  if (afterWrite !== undefined) {
    losing.delete(flow);
    lose = { bin: path.join(flow.tmp, "bin"), afterWrite };
  }
  return ownedRequest(
    { config: flow.config, env: flow.env, request, lose },
    (bound) => {
      const body = JSON.stringify({ config: flow.config, ...bound });
      const result = spawnSync(
        process.execPath,
        [path.join(flow.root, "ops.mjs")],
        {
          input: `BEGIN_OPS_REQUEST\n${body}\nEND_OPS_REQUEST`,
          env: flow.env,
          encoding: "utf8",
          timeout: RUN_MS,
        },
      );
      if (result.status !== 0) {
        throw new Error(`ops exited ${result.status}: ${result.stderr}`);
      }
      return JSON.parse(result.stdout);
    },
  );
}

// The status of `bound` on issue `number`, read by a fresh ops process.
function statusOf(flow: Flow, number: number, bound: object): TaskStatus {
  return STATUS.parse(
    rawOps(flow, { op: "task-result", number, binding: bound }),
  );
}

// The reply to reading a binding no op should accept.
function statusRefusal(flow: Flow, number: number, bound: object): TaskReply {
  return REPLY.parse(
    rawOps(flow, { op: "task-result", number, binding: bound }),
  );
}

// Records an attempt of `run` for `bound`, as the landing account does.
function recordAttempt(
  flow: Flow,
  number: number,
  bound: object,
  run: { id: string; previous: string | null },
): TaskReply {
  return REPLY.parse(
    rawOps(flow, { op: "record-task-attempt", number, binding: bound, run }),
  );
}

// Records `run`'s `verdict` for `bound`, as the landing account does.
function recordResult(
  flow: Flow,
  number: number,
  bound: object,
  { run, verdict, summary }: { run: string; verdict: string; summary: string },
): TaskReply {
  return REPLY.parse(
    rawOps(flow, {
      op: "record-task-result",
      number,
      binding: bound,
      run: { id: run },
      verdict,
      receipt: { summary },
    }),
  );
}

// Saves `state` on issue `number` through the save-state op.
function saveState(flow: Flow, number: number, state: object): TaskReply {
  return REPLY.parse(rawOps(flow, { op: "save-state", number, state }));
}

// A revision binding for `task` of `issue` on the flow's target.
function binding({
  issue,
  task,
  code,
  target,
  inputs,
  policy,
}: {
  issue: number;
  task: string;
  code: string;
  target: string;
  inputs?: string;
  policy?: string;
}): {
  repo: string;
  workItem: number;
  task: string;
  revision: { code: string; inputs: string; policy: string };
  target: { branch: string; commit: string };
} {
  return {
    repo: "o/r",
    workItem: issue,
    task,
    revision: {
      code,
      inputs: inputs ?? digest("inputs"),
      policy: policy ?? digest("policy"),
    },
    target: { branch: BASE, commit: target },
  };
}

function plantComment(
  dir: string,
  issue: number,
  login: string,
  body: string,
): number {
  return withWorld(dir, (world) => postComment(world, issue, login, body).id);
}

function recordText(record: object): string {
  return `${MARK}${JSON.stringify(record)}${END}`;
}

function commentsOn(
  dir: string,
  issue: number,
): { id: number; login: string; body: string }[] {
  return readWorld(dir).comments.filter(
    (item) => item.issue === issue && !item.body.startsWith(COORDINATION),
  );
}

// Returns the kinds of the issue's task records, in order
function recordKindsOn(dir: string, issue: number): string[] {
  return commentsOn(dir, issue)
    .filter((item) => item.body.startsWith(MARK))
    .map(
      (item) =>
        KIND.parse(JSON.parse(item.body.slice(MARK.length, -END.length))).kind,
    );
}

// Returns the gh calls so far, to slice writes after
function callMark(dir: string): number {
  return ghCalls(dir).length;
}

// Returns gh calls that change GitHub
function writesSince(dir: string, from = 0): string[][] {
  return ghCalls(dir)
    .slice(from)
    .filter((args) => args.some((arg) => GH_WRITE.test(arg)))
    .filter((args) => !isCoordinationWrite(args));
}

// A version 2 saved state for `issue` with `extra` over a new issue's, as
// the landing account saved it before task results existed.
function v2State(issue: number, extra: object): Record<string, unknown> {
  return {
    version: 2,
    number: issue,
    stage: "merge",
    stoppedStage: null,
    stopCode: null,
    resumeStage: null,
    lease: null,
    pr: null,
    branch: `agent/issue-${issue}`,
    headSha: null,
    flows: { code: true },
    gherkin: null,
    authorUsed: true,
    requirementsInputs: null,
    review: {
      round: 0,
      verdict: null,
      commentId: null,
      findings: [],
      revision: null,
    },
    hardened: null,
    hardenedTarget: null,
    integration: null,
    security: null,
    verifiedSha: null,
    mergeReturn: null,
    merged: null,
    codeMerged: null,
    mergeAttempt: null,
    asked: null,
    counts: { conflictFixes: 0, syncs: 0 },
    log: [],
    ...extra,
  };
}

function stateText(state: object): string {
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
}

// flow: forgets every local run folder
function dropRunFolders(flow: Flow): void {
  fs.rmSync(path.join(flow.root, "runs"), { recursive: true, force: true });
}

export type { TaskReply, TaskStatus };
export {
  binding,
  callMark,
  commentsOn,
  digest,
  dropRunFolders,
  loseNextOwnership,
  plantComment,
  rawOps,
  recordAttempt,
  recordKindsOn,
  recordResult,
  recordText,
  runId,
  saveState,
  stateText,
  statusOf,
  statusRefusal,
  taskWorld,
  v2State,
  writesSince,
};
