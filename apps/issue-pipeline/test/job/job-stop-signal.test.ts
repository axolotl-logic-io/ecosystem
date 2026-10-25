// A stop child may save signed state before interruption; signal cleanup must
// not replace that state with the parent's older working-stage checkpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { RoleStageEnd } from "../../src/job/role-end.ts";
import type { StopSignal } from "../../src/job/status.ts";
import type { IssueState } from "../../src/state.ts";
import { installFakeGh } from "../fake-gh.ts";
import { roleJob } from "./role-job-test-kit.ts";

const { testConfig }: typeof import("../config-test-kit.ts") = await import(
  "../config-test-kit.ts"
);
const { runRoleStage }: typeof import("../../src/job/role-run.ts") =
  await import("../../src/job/role-run.ts");
const { newIssueState }: typeof import("../../src/state.ts") = await import(
  "../../src/state.ts"
);
const { paths }: typeof import("../../src/config.ts") = await import(
  "../../src/config.ts"
);
const fake = installFakeGh();
fake.reply([
  { when: "api repos/example/repo/collaborators/alice", keep: true },
]);
const { cfg } = testConfig({ allowedUsers: ["alice"] });
const ISSUE = 7;
const RECOVERY_ID = z.object({ recoveryId: z.uuid() });
const EVIDENCE = z.object({
  result: z.literal("reconciliation-required"),
  stopFailure: z.string(),
});

async function interrupted(interruptOn: "stop" | "release"): Promise<{
  state: IssueState;
  calls: { op: string; payload: object }[];
  end: RoleStageEnd;
}> {
  const state = newIssueState(ISSUE);
  state.stage = "review";
  const calls: { op: string; payload: object }[] = [];
  let signal: StopSignal | null = null;
  const job = roleJob((op, payload) => {
    calls.push({ op, payload });
    if (op === interruptOn) {
      signal = "SIGTERM";
      return Promise.resolve({
        ok: false,
        error: "child interrupted after state write",
      });
    }
    if (op === "claim") {
      return Promise.resolve({
        ok: true,
        reply: {
          state,
          remoteHead: null,
          issueFile: "unused",
          comments: [],
          issue: { title: "Work", body: "", user: { login: "alice" } },
        },
      });
    }
    if (op === "verify" && interruptOn === "stop") {
      return Promise.resolve({
        ok: false,
        error: "required operation rejected",
      });
    }
    return Promise.resolve({ ok: true, reply: {} });
  });
  job.cfg = cfg;
  job.control.stopping = (): "SIGTERM" | "SIGINT" | null => signal;
  const end = await runRoleStage(job);
  return { state, calls, end };
}

test("a signal interrupting stop never overwrites a possibly landed signed state", async () => {
  const { calls, end } = await interrupted("stop");
  assert.deepEqual(end, { kind: "stopped", signal: "SIGTERM" });
  assert.deepEqual(
    calls.filter((call) => call.op === "save-state"),
    [],
  );
  const stopped = calls.find((call) => call.op === "stop");
  const { recoveryId } = RECOVERY_ID.parse(stopped?.payload);
  const file = path.join(
    paths.runDir(cfg, ISSUE),
    "stop-recovery",
    `${recoveryId}.json`,
  );
  const evidence = EVIDENCE.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.ok(
    evidence.stopFailure.includes("child interrupted after state write"),
  );
});
