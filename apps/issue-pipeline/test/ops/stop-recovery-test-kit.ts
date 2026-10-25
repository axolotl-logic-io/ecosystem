// The real stop operation, authenticated fake gh, editor-provenance reads and
// actual saved state PATCHes. No sleeps or inferred hardening in recovery.
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import { z } from "zod";
import type { Config } from "../../src/config.ts";
import type { OpsReply, RunOp } from "../../src/job/ops-request.ts";
import type { Claimed } from "../../src/job/role-end.ts";
import type { IssueState } from "../../src/state.ts";
import { credentialConfig } from "../credentials-test-kit.ts";
import type { GhReply } from "../fake-gh.ts";
import { claimComment } from "../fake-gh.ts";
import { stopMutationReplies } from "../gh-mutation-fixtures.ts";
import { everyCommentsRead, kit, v2State } from "../ops-v2-test-kit.ts";

const { loadConfig, paths }: typeof import("../../src/config.ts") =
  await import("../../src/config.ts");
const { ISSUE_STATE }: typeof import("../../src/state.ts") = await import(
  "../../src/state.ts"
);
const { runUsage }: typeof import("../../src/job/run-usage.ts") = await import(
  "../../src/job/run-usage.ts"
);
const { stop }: typeof import("../../src/ops/stop.ts") = await import(
  "../../src/ops/stop.ts"
);
const EVIDENCE = z.object({
  result: z.string(),
  issue: z.number(),
  branch: z.string(),
  resumeStage: z.string().nullable(),
  stopCode: z.string(),
  updates: z.record(z.string(), z.string()),
  originalFailure: z.string(),
  stopFailure: z.string().nullable(),
});
const ISSUE = 71;
const PR = 7;
const SHA_LENGTH = 40;
const REASON = "the push op failed after checks; hardened heads were not saved";
const LOGIN = "api user --jq .login";
const FIRST_WAIT = 2000;
const ATTEMPTS = 4;
const RECONCILIATION = /reconciliation-required/u;
const INPUTS = {
  revision: "inputs",
  gherkin: null,
  comments: [],
  issue: { title: "Review work", body: "", user: { login: "alice" } },
};
let sequence = 0;

function noSleep(): number[] {
  const waits: number[] = [];
  function wait(
    _array: Int32Array | BigInt64Array,
    _at: number,
    _value: number | bigint,
    ms: number,
  ): "timed-out" {
    waits.push(ms);
    return "timed-out";
  }
  mock.method(Atomics, "wait", wait);
  return waits;
}

function setup(): {
  cfg: Config;
  state: IssueState;
  account: string;
  token: string;
} {
  sequence += 1;
  const account = `stop-test-${sequence}`;
  const cfg = loadConfig(kit.configWith(credentialConfig(account)));
  const state = ISSUE_STATE.parse(
    v2State(ISSUE, {
      stage: "review",
      pr: PR,
      branch: paths.branch(cfg, ISSUE),
      lease: { lane: "me", sweepId: "s1", at: new Date().toISOString() },
      headSha: "a".repeat(SHA_LENGTH),
      verifiedSha: "a".repeat(SHA_LENGTH),
      merged: null,
      hardened: null,
    }),
  );
  return { cfg, state, account, token: `fake-pipeline-merge--${account}` };
}

function evidenceOf(cfg: Config): z.infer<typeof EVIDENCE>[] {
  const dir = path.join(paths.runDir(cfg, ISSUE), "stop-recovery");
  return fs
    .readdirSync(dir)
    .map((file) =>
      EVIDENCE.parse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))),
    );
}

function stopReplies(cfg: Config, state: IssueState): GhReply[] {
  const claimId = 81;
  return [
    {
      ...everyCommentsRead(ISSUE, [
        kit.issueComment(
          ISSUE,
          `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
          cfg.mergeAccount,
        ),
        claimComment({
          id: claimId,
          lane: "me",
          sweep: "s1",
          login: cfg.mergeAccount,
          at: new Date().toISOString(),
        }),
      ]),
      persistState: true,
    },
    ...stopMutationReplies(ISSUE, {
      stateId: ISSUE,
      pr: PR,
      code: "error",
      claims: [claimId],
    }),
  ];
}

function clearEvidence(): void {
  fs.rmSync(path.join(kit.runDir(ISSUE), "stop-recovery"), {
    recursive: true,
    force: true,
  });
}

function confirmedStop(): { cfg: Config; file: string } {
  clearEvidence();
  const { cfg, state } = setup();
  kit.reply(stopReplies(cfg, state));
  stop(cfg, { number: ISSUE, state, code: "error", reason: REASON });
  const dir = path.join(paths.runDir(cfg, ISSUE), "stop-recovery");
  const [name] = fs.readdirSync(dir);
  if (name === undefined) {
    throw new Error("missing stop recovery fixture");
  }
  return { cfg, file: path.join(dir, name) };
}

function stopJob(cfg: Config, state: IssueState, runOp: RunOp): Claimed {
  return {
    job: {
      cfg,
      issue: ISSUE,
      stage: "review",
      status: {
        moved: (): never => {
          throw new Error("stop must not advance stage");
        },
      },
      runOp,
    },
    last: state,
    usage: runUsage("review", new Date()),
  };
}

function stopChild(cfg: Config): RunOp {
  return (op: string, payload: object): Promise<OpsReply> => {
    if (op !== "stop") {
      throw new Error(`unexpected stop-child operation: ${op}`);
    }
    try {
      return Promise.resolve({
        ok: true,
        reply: stop(cfg, { number: ISSUE, ...payload }),
      });
    } catch (error) {
      let failure = String(error);
      if (error instanceof Error) {
        failure = error.message;
      }
      return Promise.resolve({ ok: false, error: failure });
    }
  };
}

export {
  ATTEMPTS,
  clearEvidence,
  confirmedStop,
  evidenceOf,
  FIRST_WAIT,
  INPUTS,
  ISSUE,
  LOGIN,
  noSleep,
  PR,
  REASON,
  RECONCILIATION,
  SHA_LENGTH,
  setup,
  stopChild,
  stopJob,
  stopReplies,
};
