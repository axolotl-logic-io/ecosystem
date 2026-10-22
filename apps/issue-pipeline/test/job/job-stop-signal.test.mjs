// @ts-check
// A stop child may save signed state before interruption; signal cleanup must
// not replace that state with the parent's older working-stage checkpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { installFakeGh } from "../fake-gh.mjs";
import { roleJob } from "./role-job-test-kit.mjs";

const { testConfig } = await import("../config-test-kit.mjs");
const { runRoleStage } = await import("../../src/job/role-run.ts");
const { newIssueState } = await import("../../src/state.ts");
const { paths } = await import("../../src/config.ts");
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

/** @param {"stop" | "release"} interruptOn @returns {Promise<{state: import("../../src/state.ts").IssueState, calls: {op: string, payload: object}[], end: import("../../src/job/role-end.ts").RoleStageEnd}>} */
async function interrupted(interruptOn) {
  const state = newIssueState(ISSUE);
  state.stage = "review";
  /** @type {{ op: string, payload: object }[]} */
  const calls = [];
  /** @type {import("../../src/job/status.ts").StopSignal | null} */
  let signal = null;
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
  job.control.stopping = () => signal;
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

test("a signal outside stop still saves the last checkpoint without its lease", async () => {
  const { state, calls, end } = await interrupted("release");
  assert.deepEqual(end, { kind: "stopped", signal: "SIGTERM" });
  const saves = calls.filter((call) => call.op === "save-state");
  assert.deepEqual(
    saves.map((call) => call.payload),
    [{ state: { ...state, lease: null } }],
  );
});
