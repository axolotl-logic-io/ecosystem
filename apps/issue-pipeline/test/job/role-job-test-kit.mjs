// @ts-check
// In-process role jobs with real status and isolated roots; unexpected model launches fail.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { testConfig } from "../config-test-kit.mjs";
import { isolatedRoot } from "../isolated-root-test-kit.mjs";

const { openStatus } = await import("../../src/job/status.ts");

/** @typedef {import("../../src/job/ops-request.ts").OpsReply} Reply */
/** @param {Record<string, Reply>} [replies] */
function fakeOps(replies = {}) {
  /** @type {{op: string, payload: object}[]} */
  const calls = [];
  /** @param {string} op @param {object} payload @returns {Promise<Reply>} */
  function runOp(op, payload) {
    calls.push({ op, payload });
    return Promise.resolve(replies[op] ?? { ok: true, reply: {} });
  }
  return { calls, runOp };
}

/** @returns {never} */
function unexpectedLaunch() {
  throw new Error("this role must not launch a model or ops child");
}

/** @param {import("../../src/job/ops-request.ts").RunOp} runOp @param {Partial<import("../../src/job/role-run.ts").RoleJob>} [changes] @returns {import("../../src/job/role-run.ts").RoleJob} */
function roleJob(runOp, changes = {}) {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  return {
    cfg: testConfig({ allowedUsers: ["alice"] }).cfg,
    issue: 7,
    stage: "review",
    mergeQueue: null,
    identity: { id, startedAt },
    dirs: {
      root: isolatedRoot,
      repo: isolatedRoot,
      branch: "agent/issue-7",
    },
    prompts: { pinned: [], promptFor: unexpectedLaunch },
    status: openStatus(path.join(isolatedRoot, id), {
      id,
      startedAt,
      issue: 7,
      stage: "review",
      lane: "lane",
      socket: "unused",
      prompts: [],
    }),
    hooks: {
      sessionFile: unexpectedLaunch,
      started: unexpectedLaunch,
      record: unexpectedLaunch,
      ended: unexpectedLaunch,
      sessionEnded: unexpectedLaunch,
      env: unexpectedLaunch,
      cwd: isolatedRoot,
      repo: isolatedRoot,
    },
    control: { stopping: () => null },
    onClaimed: () => undefined,
    runOp,
    role: async (ctx) => {
      await ctx.op("verify", {});
      return { kind: "next", state: ctx.state };
    },
    ...changes,
  };
}

export { fakeOps, roleJob };
