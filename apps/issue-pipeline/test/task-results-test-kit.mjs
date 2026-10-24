// @ts-check
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
import { ghCalls, openIssue } from "./fake-pipeline-flow-gh.mjs";
import {
  postComment,
  readWorld,
  withWorld,
} from "./fake-pipeline-flow-gh-world.mjs";
import { BASE, bareGit, setUpFlow } from "./pipeline-flow-test-kit.mjs";

const RUN_MS = 60_000;
const MARK = "<!-- agent-pipeline:task-result\n";
const END = "\n-->";
const KIND = z.looseObject({ kind: z.string() });
const GH_WRITE = /^(?:-X|--method)$/u;

/** @param {string} text @returns {string} */
function digest(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** @param {number} issue */
function taskWorld(issue) {
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

/**
 * The raw reply of one fresh ops process to `request`.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {object} request
 * @returns {unknown}
 */
function rawOps(flow, request) {
  const body = JSON.stringify({ config: flow.config, ...request });
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
}

/**
 * The status of `bound` on issue `number`, read by a fresh ops process.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {number} number @param {object} bound
 */
function statusOf(flow, number, bound) {
  return STATUS.parse(
    rawOps(flow, { op: "task-result", number, binding: bound }),
  );
}

/**
 * The reply to reading a binding no op should accept.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {number} number @param {object} bound
 */
function statusRefusal(flow, number, bound) {
  return REPLY.parse(
    rawOps(flow, { op: "task-result", number, binding: bound }),
  );
}

/**
 * Records an attempt of `run` for `bound`, as the landing account does.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {number} number @param {object} bound
 * @param {{ id: string, previous: string | null }} run
 */
function recordAttempt(flow, number, bound, run) {
  return REPLY.parse(
    rawOps(flow, { op: "record-task-attempt", number, binding: bound, run }),
  );
}

/**
 * Records `run`'s `verdict` for `bound`, as the landing account does.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {number} number @param {object} bound
 * @param {{ run: string, verdict: string, summary: string }} result
 */
function recordResult(flow, number, bound, { run, verdict, summary }) {
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

/**
 * Saves `state` on issue `number` through the save-state op.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {number} number @param {object} state
 */
function saveState(flow, number, state) {
  return REPLY.parse(rawOps(flow, { op: "save-state", number, state }));
}

/**
 * A revision binding for `task` of `issue` on the flow's target.
 * @param {{ issue: number, task: string, code: string, target: string, inputs?: string, policy?: string }} parts
 */
function binding({ issue, task, code, target, inputs, policy }) {
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

/** @param {string} dir @param {number} issue @param {string} login @param {string} body @returns {number} */
function plantComment(dir, issue, login, body) {
  return withWorld(dir, (world) => postComment(world, issue, login, body).id);
}

/** @param {object} record @returns {string} */
function recordText(record) {
  return `${MARK}${JSON.stringify(record)}${END}`;
}

/** @param {string} dir @param {number} issue @returns {{ id: number, login: string, body: string }[]} */
function commentsOn(dir, issue) {
  return readWorld(dir).comments.filter((item) => item.issue === issue);
}

/** @param {string} dir @param {number} issue @returns {string[]} the kinds of the issue's task records, in order */
function recordKindsOn(dir, issue) {
  return commentsOn(dir, issue)
    .filter((item) => item.body.startsWith(MARK))
    .map(
      (item) =>
        KIND.parse(JSON.parse(item.body.slice(MARK.length, -END.length))).kind,
    );
}

/** @param {string} dir @returns {number} the gh calls so far, to slice writes after */
function callMark(dir) {
  return ghCalls(dir).length;
}

/** @param {string} dir @param {number} [from] @returns {string[][]} gh calls that change GitHub */
function writesSince(dir, from = 0) {
  return ghCalls(dir)
    .slice(from)
    .filter((args) => args.some((arg) => GH_WRITE.test(arg)));
}

// A version 2 saved state for `issue` with `extra` over a new issue's, as
// the landing account saved it before task results existed.
/** @param {number} issue @param {object} extra @returns {Record<string, unknown>} */
function v2State(issue, extra) {
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

/** @param {object} state @returns {string} */
function stateText(state) {
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow forgets every local run folder */
function dropRunFolders(flow) {
  fs.rmSync(path.join(flow.root, "runs"), { recursive: true, force: true });
}

export {
  binding,
  callMark,
  commentsOn,
  digest,
  dropRunFolders,
  plantComment,
  recordAttempt,
  recordKindsOn,
  recordResult,
  recordText,
  saveState,
  stateText,
  statusOf,
  statusRefusal,
  taskWorld,
  v2State,
  writesSince,
};
