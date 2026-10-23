// @ts-check
// Policy changes expire clearance, not retained authority or a known finding.
// A policy-moved merged result is never re-observed by a postmerge Security
// session (#185); it stops with merged truth retained.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  opNames,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  cfg,
  current,
  mergeRole,
  REVISION,
  sha,
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  AFTER_MERGE,
  CODE_MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  PREPARED_MERGED,
} from "./merge-role-test-kit.mjs";

const { policyRevision } = await import("../../../src/project-policy.ts");
const {
  candidateRefusal,
  currentResultObservation,
  resultReviewTarget,
  securityRefusal,
} = await import("../../../src/security-clearance.ts");
const { finishGate } = await import("../../../src/ops/finish-guard.ts");
const { policyBinding: _binding, ...unboundConfig } = cfg;
let oldConfig = { ...unboundConfig, requireCi: true };
if (policyRevision(oldConfig).policy === policyRevision(cfg).policy) {
  oldConfig = { ...unboundConfig, requireCi: false };
}
const OLD = { ...REVISION, ...policyRevision(oldConfig) };
const THIRD_POLICY = policyRevision({
  ...unboundConfig,
  commandTimeoutMinutes: 123,
}).policy;
const RESULT = { ...OLD, code: MERGED_REVISION.code };
const TARGET = { repo: cfg.repo, branch: cfg.baseBranch, sha: sha("b") };
const CANDIDATE = {
  revision: OLD,
  commentId: 61,
  finding: null,
  phase: /** @type {const} */ ("candidate"),
  target: TARGET,
};
const STATE = {
  ...merging().ctx.state,
  ...CODE_MERGED,
  hardened: OLD,
  merged: RESULT,
  security: CANDIDATE,
};
const FORBIDDEN = ["merge", "push", "sync-base", "ready-pr", "finish-sync"];

/** @param {Parameters<typeof merging>[0]} [script] */
function observing(script = {}) {
  return merging({
    ...script,
    state: { ...STATE, ...script.state },
    ops: {
      "current-revision": [AFTER_MERGE, AFTER_MERGE],
      "prepare-review": [PREPARED_MERGED],
      ...script.ops,
    },
  });
}
/** @param {Parameters<typeof opNames>[0]} calls */
function readOnly(calls) {
  return [
    opNames(calls).every((name) => !FORBIDDEN.includes(name)),
    sessionsOf(calls).every(
      (spec) => spec.commits === false && spec.phase === "security-review",
    ),
  ];
}

test("same-policy candidate clearance completes without another Security session", async () => {
  assert.notEqual(OLD.policy, REVISION.policy);
  const { ctx, calls } = observing({
    state: {
      hardened: REVISION,
      merged: MERGED_REVISION,
      security: { ...CANDIDATE, revision: REVISION },
    },
  });
  const done = stateOf(await mergeRole(ctx), "next");
  assert.equal(done.stage, "done");
  assert.equal(done.resultSecurity ?? null, null);
  assert.equal(sessionsOf(calls).length, 0);
  assert.deepEqual(readOnly(calls), [true, true]);
});

test("proven policy-moved candidate stops without a postmerge result observation, retaining merged truth", async () => {
  assert.notEqual(OLD.policy, REVISION.policy);
  const { ctx, calls } = observing();
  const before = structuredClone(ctx.state);
  const stopped = stateOf(await mergeRole(ctx), "stop");
  assert.notEqual(stopped.stage, "done");
  assert.deepEqual(stopped.security, before.security);
  assert.deepEqual(stopped.merged, before.merged);
  assert.deepEqual(stopped.hardened, before.hardened);
  assert.deepEqual(stopped.mergeAttempt, before.mergeAttempt);
  assert.equal(stopped.resultSecurity ?? null, null);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(opNames(calls).includes("prepare-review"), false);
  assert.equal(opNames(calls).includes("finish"), false);
  // A result observation saved before #185 still clears exactly its result.
  const done = {
    ...before,
    stage: /** @type {const} */ ("done"),
    resultSecurity: {
      revision: { ...MERGED_REVISION, policy: policyRevision(cfg).policy },
      target: TARGET,
      commentId: 62,
      finding: null,
    },
  };
  assert.equal(securityRefusal(done, MERGED_REVISION), undefined);
  const fresh = {
    ...AFTER_MERGE,
    codeMerged: CODE_MERGED.codeMerged,
    checkoutHead: MERGED_REVISION.code,
    remoteHead: REVISION.code,
    issueFile: "issue.md",
    pr: { ...MERGED_PR, state: /** @type {const} */ ("MERGED") },
  };
  assert.equal(finishGate(done, fresh), undefined);
  assert.notEqual(THIRD_POLICY, OLD.policy);
  assert.notEqual(THIRD_POLICY, REVISION.policy);
  const moved = {
    ...fresh,
    revision: { ...MERGED_REVISION, policy: THIRD_POLICY },
  };
  assert.equal(finishGate(done, moved)?.reason, "security");
  assert.deepEqual(readOnly(calls), [true, true]);
});

test("policy-moved result without original target provenance is refused", async () => {
  assert.notEqual(OLD.policy, REVISION.policy);
  const { ctx, calls } = observing({ state: { hardenedTarget: null } });
  const stopped = stateOf(await mergeRole(ctx), "stop");
  assert.equal(stopped.resultSecurity ?? null, null);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(opNames(calls).includes("finish"), false);
  assert.deepEqual(readOnly(calls), [true, true]);
});

test("an unconfirmed result never enters policy re-observation", () => {
  assert.equal(
    resultReviewTarget({ ...STATE, merged: null }, MERGED_REVISION),
    null,
  );
  assert.equal(
    resultReviewTarget({ ...STATE, hardened: null }, MERGED_REVISION),
    null,
  );
});

for (const slot of /** @type {const} */ (["security", "resultSecurity"])) {
  test(`policy movement does not reroll a rejection in ${slot}`, async () => {
    assert.notEqual(OLD.policy, REVISION.policy);
    const rejection = {
      revision: RESULT,
      commentId: 71,
      finding: {
        category: /** @type {const} */ ("rights"),
        reason: "private data",
      },
    };
    /** @type {Partial<import("../../../src/state.ts").IssueState>} */
    let state = { security: rejection };
    if (slot === "resultSecurity") {
      state = {
        resultSecurity: {
          ...rejection,
          revision: { ...RESULT, policy: OLD.policy },
          target: TARGET,
        },
      };
    }
    const { ctx, calls } = observing({ state });
    stateOf(await mergeRole(ctx), "stop");
    assert.equal(sessionsOf(calls).length, 0);
    assert.equal(opNames(calls).includes("finish"), false);
    assert.deepEqual(readOnly(calls), [true, true]);
  });
}

test("a second policy movement after a policy-moved merge stops without result Security or looping", async () => {
  assert.notEqual(OLD.policy, REVISION.policy);
  assert.notEqual(THIRD_POLICY, OLD.policy);
  assert.notEqual(THIRD_POLICY, REVISION.policy);
  const moved = current(
    { ...MERGED_REVISION, policy: THIRD_POLICY },
    MERGED_PR,
  );
  const { ctx, calls } = observing({
    ops: { "current-revision": [AFTER_MERGE, moved] },
  });
  const stopped = stateOf(await mergeRole(ctx), "stop");
  assert.equal(stopped.resultSecurity ?? null, null);
  assert.deepEqual(stopped.security, CANDIDATE);
  assert.deepEqual(stopped.merged, RESULT);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(opNames(calls).includes("finish"), false);
  assert.deepEqual(readOnly(calls), [true, true]);
});

test("a policy movement after a policy-moved merge never runs a result Security session that could set or discard a finding", async () => {
  assert.notEqual(OLD.policy, REVISION.policy);
  assert.notEqual(THIRD_POLICY, OLD.policy);
  assert.notEqual(THIRD_POLICY, REVISION.policy);
  const moved = current(
    { ...MERGED_REVISION, policy: THIRD_POLICY },
    MERGED_PR,
  );
  const { ctx, calls } = observing({
    ops: { "current-revision": [AFTER_MERGE, moved] },
    sessions: [
      {
        ok: true,
        reply: {
          summary: "Unsafe",
          security: { category: "rights", reason: "private data" },
        },
      },
    ],
  });
  const stopped = stateOf(await mergeRole(ctx), "stop");
  assert.equal(stopped.resultSecurity ?? null, null);
  assert.deepEqual(stopped.security, CANDIDATE);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(opNames(calls).includes("finish"), false);
  assert.deepEqual(readOnly(calls), [true, true]);
});

test("missing historical policy remains unbound and cannot become candidate clearance", () => {
  assert.notEqual(OLD.policy, REVISION.policy);
  const { policy: _policy, ...legacy } = OLD;
  const original = {
    ...STATE,
    hardened: legacy,
    security: { ...CANDIDATE, revision: legacy },
    merged: { ...legacy, code: RESULT.code },
  };
  const before = structuredClone(original);
  assert.equal(resultReviewTarget(original, MERGED_REVISION), null);
  assert.notEqual(
    candidateRefusal(
      { ...original, verifiedSha: legacy.code },
      legacy,
      cfg,
      TARGET.sha,
    ),
    undefined,
  );
  assert.deepEqual(
    currentResultObservation(original.merged, MERGED_REVISION),
    MERGED_REVISION,
  );
  assert.deepEqual(original, before);
});
