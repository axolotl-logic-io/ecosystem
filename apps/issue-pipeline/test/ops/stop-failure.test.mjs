// @ts-check
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { kit } from "../ops-v2-test-kit.mjs";
import {
  clearEvidence,
  evidenceOf,
  ISSUE,
  LOGIN,
  noSleep,
  REASON,
  RECONCILIATION,
  setup,
  stopReplies,
} from "./stop-recovery-test-kit.mjs";

const { stop } = await import("../../src/ops/stop.ts");
const { withCheckout } = await import("../../src/config.ts");
afterEach(() => mock.restoreAll());

const CASES = [
  {
    name: "state save",
    when: `api -X PATCH repos/o/r/issues/comments/${ISSUE}`,
    state: "unresolved",
    working: "unresolved",
    labels: "unresolved",
  },
  {
    name: "working-label deletion",
    when: `api -X DELETE repos/o/r/issues/${ISSUE}/labels/agent%3Aworking`,
    state: "confirmed",
    working: "unresolved",
    labels: "unresolved",
  },
  {
    name: "claim closure",
    when: "api -X PATCH repos/o/r/issues/comments/81",
    state: "confirmed",
    working: "confirmed",
    labels: "confirmed",
  },
];
for (const failure of CASES) {
  test(`required ${failure.name} failure is reconciliation, never silently accepted`, () => {
    clearEvidence();
    const { cfg, state, token } = setup();
    kit.reply([
      { when: failure.when, code: 1, stderr: `update rejected ${token}` },
      ...stopReplies(cfg, state),
    ]);
    assert.throws(
      () => stop(cfg, { number: ISSUE, state, code: "error", reason: REASON }),
      RECONCILIATION,
    );
    const [record] = evidenceOf(cfg);
    const { state: stateUpdate, claim } = record?.updates ?? {};
    assert.equal(record?.result, "reconciliation-required");
    assert.equal(stateUpdate, failure.state);
    assert.equal(record?.updates[`working-label:${ISSUE}`], failure.working);
    assert.equal(record?.updates[`labels:${ISSUE}`], failure.labels);
    assert.equal(claim, "unresolved");
    assert.ok(record?.stopFailure?.includes("update rejected <token>"));
    assert.equal(JSON.stringify(record).includes(token), false);
  });
}

test("HTTP 401 during stop leaves a branch-specific operator result without retries or writes", () => {
  clearEvidence();
  const waits = noSleep();
  const { cfg, state, token } = setup();
  const branch = "assigned/custom-stop-recovery";
  const assigned = withCheckout(cfg, { issue: ISSUE, branch, dir: kit.root });
  kit.reply([{ when: LOGIN, stderr: `HTTP 401 ${token}`, code: 1 }]);
  assert.throws(
    () =>
      stop(assigned, { number: ISSUE, state, code: "error", reason: REASON }),
    RECONCILIATION,
  );
  assert.deepEqual(waits, []);
  assert.equal(kit.writes().length, 0);
  const [record] = evidenceOf(assigned);
  assert.equal(record?.branch, branch);
  assert.equal(record?.resumeStage, "review");
  assert.ok(record?.stopFailure?.includes("authentication rejected"));
  assert.equal(JSON.stringify(record).includes(token), false);
});

test("a successful state write without matching authoritative readback remains unresolved", () => {
  clearEvidence();
  const { cfg, state } = setup();
  const replies = stopReplies(cfg, state).map((reply) => ({
    ...reply,
    persistState: false,
  }));
  kit.reply(replies);
  assert.throws(
    () => stop(cfg, { number: ISSUE, state, code: "error", reason: REASON }),
    RECONCILIATION,
  );
  const [record] = evidenceOf(cfg);
  const { state: stateUpdate, lease } = record?.updates ?? {};
  assert.equal(stateUpdate, "unresolved");
  assert.equal(lease, "unresolved");
  assert.ok(record?.stopFailure?.includes("authoritative reread"));
  assert.equal(
    kit.writes().some((args) => args.some((arg) => arg.includes("/labels"))),
    false,
  );
});

test("already absent working labels are idempotent cleanup, not a failed stop", () => {
  clearEvidence();
  const { cfg, state } = setup();
  kit.reply([
    {
      when: `api -X DELETE repos/o/r/issues/${ISSUE}/labels/agent%3Aworking`,
      code: 1,
      stderr: "HTTP 404",
    },
    ...stopReplies(cfg, state),
  ]);
  const result = stop(cfg, {
    number: ISSUE,
    state,
    code: "error",
    reason: REASON,
  });
  assert.equal(result.state.stopCode, "error");
  assert.equal(evidenceOf(cfg)[0]?.result, "signed-stop-confirmed");
});
