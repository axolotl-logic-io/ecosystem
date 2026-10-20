// @ts-check
// The real stop operation, authenticated fake gh, editor-provenance reads and
// actual saved state PATCHes. No sleeps or inferred hardening in recovery.
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import { z } from "zod";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { stopMutationReplies } from "./gh-mutation-fixtures.mjs";
import { everyCommentsRead, kit, v2State } from "./ops-v2-test-kit.mjs";

const { loadConfig, paths } = await import("../src/config.ts");
const { ISSUE_STATE } = await import("../src/state.ts");
const { runUsage } = await import("../src/job/run-usage.ts");
const { stop } = await import("../src/ops/stop.ts");
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

/** @returns {number[]} */
function noSleep() {
  /** @type {number[]} */
  const waits = [];
  /** @param {Int32Array | BigInt64Array} _array @param {number} _at @param {number | bigint} _value @param {number} ms @returns {"timed-out"} */
  function wait(_array, _at, _value, ms) {
    waits.push(ms);
    return "timed-out";
  }
  mock.method(Atomics, "wait", wait);
  return waits;
}

/** @returns {{cfg: import("../src/config.ts").Config, state: import("../src/state.ts").IssueState, account: string, token: string}} */
function setup() {
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

/** @param {import("../src/config.ts").Config} cfg @returns {z.infer<typeof EVIDENCE>[]} */
function evidenceOf(cfg) {
  const dir = path.join(paths.runDir(cfg, ISSUE), "stop-recovery");
  return fs
    .readdirSync(dir)
    .map((file) =>
      EVIDENCE.parse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))),
    );
}

/** @param {import("../src/config.ts").Config} cfg @param {import("../src/state.ts").IssueState} state @returns {import("./fake-gh.mjs").GhReply[]} */
function stopReplies(cfg, state) {
  const claimId = 81;
  return [
    {
      ...everyCommentsRead(ISSUE, [
        kit.issueComment(
          ISSUE,
          `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
          cfg.mergeAccount,
        ),
        kit.issueComment(
          claimId,
          "**🤖 issue-pipeline · claim**\n<!-- agent-pipeline:comment role=claim -->\n<!-- agent-pipeline:claim lane=me sweep=s1 -->",
          cfg.mergeAccount,
          new Date().toISOString(),
        ),
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

/** @returns {void} */
function clearEvidence() {
  fs.rmSync(path.join(kit.runDir(ISSUE), "stop-recovery"), {
    recursive: true,
    force: true,
  });
}

/** @param {import("../src/config.ts").Config} cfg @param {import("../src/state.ts").IssueState} state @param {import("../src/job/ops-request.ts").RunOp} runOp @returns {import("../src/job/role-end.ts").Claimed} */
function stopJob(cfg, state, runOp) {
  return {
    job: {
      cfg,
      issue: ISSUE,
      stage: "review",
      status: {
        moved: () => {
          throw new Error("stop must not advance stage");
        },
      },
      runOp,
    },
    last: state,
    usage: runUsage("review", new Date()),
  };
}

/** @param {import("../src/config.ts").Config} cfg @returns {import("../src/job/ops-request.ts").RunOp} */
function stopChild(cfg) {
  return (op, payload) => {
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
