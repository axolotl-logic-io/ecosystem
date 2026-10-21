// @ts-check
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { commitOnOrigin, kit } from "./ops-v2-test-kit.mjs";
import {
  ATTEMPTS,
  clearEvidence,
  evidenceOf,
  FIRST_WAIT,
  INPUTS,
  ISSUE,
  LOGIN,
  noSleep,
  REASON,
  RECONCILIATION,
  SHA_LENGTH,
  setup,
  stopChild,
  stopJob,
  stopReplies,
} from "./stop-recovery-test-kit.mjs";

const { readWriteState } = await import("../src/saved-state.ts");
const { stop } = await import("../src/ops/stop.ts");
const { applyEnd } = await import("../src/job/role-end.ts");
afterEach(() => mock.restoreAll());

test("a transient stop login recovers into an authoritative resumable stop and closes its claim", () => {
  const waits = noSleep();
  clearEvidence();
  const { cfg, state, account } = setup();
  kit.reply([
    { when: LOGIN, stderr: "HTTP 502", code: 1 },
    { when: LOGIN, stdout: account },
    ...stopReplies(cfg, state),
  ]);
  const result = stop(cfg, {
    number: ISSUE,
    state,
    reason: REASON,
    code: "error",
  });
  assert.deepEqual(waits, [FIRST_WAIT]);
  assert.equal(result.state.stage, "stopped");
  assert.equal(result.state.stoppedStage, "review");
  assert.equal(result.state.stopCode, "error");
  assert.equal(result.state.lease, null);
  assert.deepEqual(readWriteState(cfg, ISSUE), result.state);
  const [evidence] = evidenceOf(cfg);
  assert.equal(evidence?.result, "signed-stop-confirmed");
  assert.ok(
    Object.values(evidence?.updates ?? {}).every(
      (value) => value === "confirmed",
    ),
  );
  const writes = kit.writes().flat().join("\n");
  assert.ok(writes.includes("claim-closed"));
  assert.ok(writes.includes(REASON));
  assert.ok(writes.includes("To resume"));
  assert.ok(writes.includes("agent%3Aworking"));
  assert.ok(writes.includes("labels[]=agent:stopped-error"));
});

test("persistent login failure records both failures, selected branch and every unresolved update", () => {
  noSleep();
  clearEvidence();
  const { cfg, state, token } = setup();
  kit.reply([
    { when: LOGIN, code: 1, stderr: `HTTP 503 ${token}`, keep: true },
  ]);
  assert.throws(
    () =>
      stop(cfg, {
        number: ISSUE,
        state,
        reason: `${REASON} ${token}`,
        code: "error",
      }),
    RECONCILIATION,
  );
  const [evidence] = evidenceOf(cfg);
  assert.equal(evidence?.result, "reconciliation-required");
  assert.equal(evidence?.issue, ISSUE);
  assert.equal(evidence?.branch, state.branch);
  assert.equal(evidence?.resumeStage, "review");
  assert.equal(evidence?.stopCode, "error");
  assert.ok(evidence?.originalFailure.includes(REASON));
  assert.ok(
    evidence?.stopFailure?.includes(`unverifiable after ${ATTEMPTS} attempts`),
  );
  assert.equal(JSON.stringify(evidence).includes(token), false);
  assert.ok(
    Object.values(evidence?.updates ?? {}).every(
      (value) => value === "unresolved",
    ),
  );
  assert.equal(kit.writes().length, 0);
});

test("a failed label write retains confirmed signed state, lease removal and precise incomplete cleanup", () => {
  noSleep();
  clearEvidence();
  const { cfg, state } = setup();
  kit.reply([
    {
      when: `api -X POST repos/o/r/issues/${ISSUE}/labels`,
      code: 1,
      stderr: "required update refused",
    },
    ...stopReplies(cfg, state),
  ]);
  assert.throws(
    () => stop(cfg, { number: ISSUE, state, reason: REASON, code: "error" }),
    RECONCILIATION,
  );
  const [evidence] = evidenceOf(cfg);
  const { state: stateUpdate, lease, claim } = evidence?.updates ?? {};
  assert.equal(stateUpdate, "confirmed");
  assert.equal(lease, "confirmed");
  assert.equal(evidence?.updates[`working-label:${ISSUE}`], "confirmed");
  assert.equal(evidence?.updates[`labels:${ISSUE}`], "unresolved");
  assert.equal(claim, "unresolved");
  assert.ok(evidence?.stopFailure?.includes("required update refused"));
  assert.equal(readWriteState(cfg, ISSUE).stopCode, "error");
});

test("a parent job records reconciliation if the stop child cannot return a result", async () => {
  clearEvidence();
  const { cfg, state, token } = setup();
  const claimed = stopJob(cfg, state, () =>
    Promise.resolve({ ok: false, error: `stop child failed ${token}` }),
  );
  await assert.rejects(
    () =>
      applyEnd(
        claimed,
        { kind: "stop", code: "error", reason: REASON, state },
        INPUTS,
      ),
    RECONCILIATION,
  );
  const [evidence] = evidenceOf(cfg);
  assert.equal(evidence?.result, "reconciliation-required");
  assert.ok(evidence?.stopFailure?.includes("stop child failed <token>"));
  assert.equal(JSON.stringify(evidence).includes(token), false);
});

test("parent and child retain one journal with fresh authority and precise progress after partial stop", async () => {
  clearEvidence();
  const { cfg, state } = setup();
  kit.reply([
    {
      when: `api -X POST repos/o/r/issues/${ISSUE}/labels`,
      code: 1,
      stderr: "required cleanup failed after signed state",
    },
    ...stopReplies(cfg, state),
  ]);
  const claimed = stopJob(cfg, state, stopChild(cfg));
  await assert.rejects(
    () =>
      applyEnd(
        claimed,
        {
          kind: "stop",
          code: "error",
          reason: REASON,
          state: { ...state, stage: "implement", pr: null },
        },
        INPUTS,
      ),
    RECONCILIATION,
  );
  const records = evidenceOf(cfg);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record?.result, "reconciliation-required");
  assert.equal(record?.resumeStage, "review");
  const { state: stateUpdate, lease, claim } = record?.updates ?? {};
  assert.equal(stateUpdate, "confirmed");
  assert.equal(lease, "confirmed");
  assert.equal(record?.updates[`working-label:${ISSUE}`], "confirmed");
  assert.equal(record?.updates[`labels:${ISSUE}`], "unresolved");
  assert.equal(record?.updates[`explanation:${state.pr}`], "confirmed");
  assert.equal(claim, "unresolved");
  assert.equal(record?.originalFailure, REASON);
  assert.ok(
    record?.stopFailure?.includes("required cleanup failed after signed state"),
  );
  assert.equal(readWriteState(cfg, ISSUE).stopCode, "error");
});

test("passed checks and a forged request receipt cannot supply missing saved hardening", () => {
  clearEvidence();
  const { cfg, state } = setup();
  assert.equal(state.hardened, null);
  assert.equal(state.verifiedSha, state.headSha);
  kit.reply(stopReplies(cfg, state));
  stop(cfg, {
    number: ISSUE,
    state: {
      ...state,
      hardened: {
        code: state.headSha,
        wiki: "d".repeat(SHA_LENGTH),
        inputs: "checks-passed",
      },
    },
    reason: REASON,
    code: "error",
  });
  const saved = readWriteState(cfg, ISSUE);
  assert.equal(saved.hardened, null);
  assert.equal(saved.integration, null);
  assert.equal(saved.headSha, state.headSha);
});

test("remote work and genuine receipts survive a stop without inventing hardening from passed checks", () => {
  clearEvidence();
  const code = commitOnOrigin(`agent/issue-${ISSUE}`, "review-work");
  const wikiBranch = `retained-work-${ISSUE}`;
  const wiki = commitOnOrigin(wikiBranch, "wiki-review-work");
  const { cfg, state } = setup();
  const receipt = {
    code: "b".repeat(SHA_LENGTH),
    wiki: "c".repeat(SHA_LENGTH),
    inputs: "prior-inputs",
  };
  const saved = {
    ...state,
    headSha: code,
    verifiedSha: code,
    hardened: receipt,
  };
  kit.reply(stopReplies(cfg, saved));
  const result = stop(cfg, {
    number: ISSUE,
    state: { ...state, hardened: { code, wiki, inputs: "checks-passed" } },
    reason: REASON,
    code: "error",
  });
  assert.deepEqual(result.state.hardened, receipt);
  assert.equal(result.state.integration, null);
  assert.equal(
    kit.sh(
      `git --git-dir=${kit.root}/origin.git rev-parse refs/heads/agent/issue-${ISSUE}`,
    ),
    code,
  );
  assert.equal(
    kit.sh(
      `git --git-dir=${kit.root}/origin.git rev-parse refs/heads/${wikiBranch}`,
    ),
    wiki,
  );
});
