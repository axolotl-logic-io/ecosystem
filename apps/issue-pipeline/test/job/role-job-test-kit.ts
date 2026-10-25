// In-process role jobs with real status and isolated roots; unexpected model launches fail.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpsReply as Reply, RunOp } from "../../src/job/ops-request.ts";
import type { RoleContext, RoleEnd } from "../../src/job/role-context.ts";
import type { RoleJob } from "../../src/job/role-run.ts";
import { testConfig } from "../config-test-kit.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";

const { openStatus }: typeof import("../../src/job/status.ts") = await import(
  "../../src/job/status.ts"
);

function fakeOps(replies: Record<string, Reply> = {}): {
  calls: { op: string; payload: object }[];
  runOp: (op: string, payload: object) => Promise<Reply>;
} {
  const calls: { op: string; payload: object }[] = [];
  function runOp(op: string, payload: object): Promise<Reply> {
    calls.push({ op, payload });
    return Promise.resolve(replies[op] ?? { ok: true, reply: {} });
  }
  return { calls, runOp };
}

function unexpectedLaunch(): never {
  throw new Error("this role must not launch a model or ops child");
}

function roleJob(runOp: RunOp, changes: Partial<RoleJob> = {}): RoleJob {
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
    role: async (ctx: RoleContext): Promise<RoleEnd> => {
      await ctx.op("verify", {});
      return { kind: "next", state: ctx.state };
    },
    ...changes,
  };
}

export { fakeOps, roleJob };
