// @ts-check
// Direct requirements cannot reopen a writer over retained merge evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFTER_MERGE,
  CODE_MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
} from "./merge-role-test-kit.mjs";
import { opNames, sessionsOf } from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  current,
  fakeContext,
  HEAD,
  INPUTS,
  issueState,
  MERGE_COMMIT,
  mergeRole,
  NEW_INPUTS,
  PR,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

const { requirementsState } = await import("../src/requirements.ts");
const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);
const { reauthoredState } = await import("../src/orchestrator/issue-plan.ts");
const RECONCILE = /explicit reconciliation/u;
const ATTEMPT = {
  repo: "o/r",
  pr: PR,
  target: "integration",
  branch: "agent/issue-7",
  authorized: REVISION,
  hardened: REVISION,
  integration: { reviewed: REVISION, revision: REVISION },
  result: null,
  reads: 0,
};
const REJECTION = {
  revision: MERGED_REVISION,
  commentId: COMMENT_ID,
  finding: { category: /** @type {const} */ ("rights"), reason: "Unsafe" },
};

/** @param {Partial<import('../src/state.ts').IssueState>} [fields] */
function directState(fields = {}) {
  return issueState({
    stage: "implement",
    authorUsed: false,
    requirementsInputs: INPUTS,
    gherkin: null,
    branch: ATTEMPT.branch,
    hardened: REVISION,
    integration: ATTEMPT.integration,
    ...fields,
  });
}

for (const [name, fields] of /** @type {const} */ ([
  ["confirmed code", CODE_MERGED],
  ["own receipt", { merged: MERGED_REVISION }],
  ["armed attempt", { mergeAttempt: ATTEMPT }],
  [
    "uncertain response",
    { mergeAttempt: { ...ATTEMPT, result: MERGE_COMMIT } },
  ],
  ["merged rejection", { merged: MERGED_REVISION, security: REJECTION }],
])) {
  for (const authorUsed of [false, true]) {
    test(`${name}, authorUsed=${authorUsed}: Developer entry refuses without any operation or session`, async () => {
      const saved = directState({ ...fields, authorUsed });
      const before = structuredClone(saved);
      const routed = requirementsState(saved, "review");
      /** @type {import('../src/state.ts').IssueState | null} */
      let expectedRoute = null;
      if (authorUsed) {
        expectedRoute = {
          ...saved,
          stage: "author",
          resumeStage: "review",
          hardened: null,
          integration: null,
        };
      }
      assert.deepEqual(routed, expectedRoute);
      const run = fakeContext({
        stage: "implement",
        state: saved,
        gherkin: null,
      });
      const end = await implementorRole(run.ctx);
      assert.ok(end.kind === "stop");
      assert.equal(end.code, "error");
      assert.match(end.reason, RECONCILE);
      assert.deepEqual(end.state, before);
      assert.deepEqual(saved, before);
      assert.deepEqual(run.calls, []);
    });
  }
}

test("an unrelated historical rejection does not forever block premerge direct work and remains content-scoped evidence", async () => {
  const saved = directState({ security: REJECTION });
  const routed = requirementsState(saved, "review");
  assert.ok(routed);
  assert.equal(routed.stage, "implement");
  assert.deepEqual(routed.security, REJECTION);
  const run = fakeContext({
    stage: "implement",
    state: saved,
    gherkin: null,
    ops: {
      "start-pr": [{ pr: PR, headSha: HEAD }],
      "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: true }],
    },
    sessions: [
      { ok: true, reply: { outcome: "done", summary: "Changed work" } },
    ],
  });
  const end = await implementorRole(run.ctx);
  assert.ok(end.kind === "next");
  assert.deepEqual(end.state.security, REJECTION);
  assert.deepEqual(
    sessionsOf(run.calls).map(({ commits }) => commits),
    [true],
  );
});

function mergedState() {
  return directState({
    stage: "merge",
    ...CODE_MERGED,
    merged: MERGED_REVISION,
    mergeAttempt: { ...ATTEMPT, result: MERGE_COMMIT, reads: 1 },
    verifiedSha: MERGE_COMMIT,
  });
}

test("changed inputs during direct postmerge Security stop with original authorization and no next writer", async () => {
  const saved = mergedState();
  const run = merging({
    state: saved,
    gherkin: null,
    ops: {
      "current-revision": [
        AFTER_MERGE,
        current({ code: MERGE_COMMIT, inputs: NEW_INPUTS }, MERGED_PR),
      ],
    },
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.match(end.reason, RECONCILE);
  assert.deepEqual(end.state, saved);
  assert.deepEqual(mutationsOf(run.calls), []);
  assert.deepEqual(
    sessionsOf(run.calls).map(({ commits }) => commits),
    [false],
  );
  const resumed = fakeContext({
    stage: "implement",
    state: { ...end.state, stage: "implement" },
    gherkin: null,
  });
  assert.equal((await implementorRole(resumed.ctx)).kind, "stop");
  assert.deepEqual(resumed.calls, []);
});

for (const refusedFinish of [false, true]) {
  test(`direct completion input change stops without rewriting merge and clearance evidence, finish refusal=${refusedFinish}`, async () => {
    const saved = {
      ...mergedState(),
      stage: /** @type {const} */ ("done"),
      security: { ...REJECTION, finding: null },
    };
    let observed = current(
      { code: MERGE_COMMIT, inputs: NEW_INPUTS },
      MERGED_PR,
    );
    if (refusedFinish) {
      observed = AFTER_MERGE;
    }
    const run = merging({
      state: saved,
      gherkin: null,
      ops: {
        "current-revision": [observed],
        finish: [{ finished: false, reason: "inputs-changed" }],
      },
    });
    const end = await mergeRole(run.ctx);
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "error");
    assert.match(end.reason, RECONCILE);
    assert.deepEqual(end.state, saved);
    assert.deepEqual(sessionsOf(run.calls), []);
    const allowed = new Set(["current-revision", "verify", "finish"]);
    assert.ok(opNames(run.calls).every((name) => allowed.has(name)));
  });
}

test("a direct postmerge requirements plan holds instead of saving a Developer stage or clearing authorization", () => {
  const saved = mergedState();
  const before = structuredClone(saved);
  const plan = reauthoredState(
    { fresh: saved, seen: saved },
    { resumeStage: "review" },
    { now: new Date("2026-10-21T00:00:00Z"), leaseMs: 0 },
  );
  assert.ok(plan.kind === "held");
  assert.match(plan.reason, RECONCILE);
  assert.deepEqual(saved, before);
});

test("ordinary premerge direct requirements still return to Developer and legacy authored merged work still returns to Author", () => {
  const direct = requirementsState(directState(), "review");
  assert.ok(direct);
  assert.equal(direct.stage, "implement");
  assert.equal(direct.headSha, HEAD);
  const legacy = requirementsState(
    { ...mergedState(), authorUsed: true },
    "review",
  );
  assert.ok(legacy);
  assert.equal(legacy.stage, "author");
  assert.deepEqual(legacy.mergeAttempt, mergedState().mergeAttempt);
  assert.deepEqual(legacy.merged, MERGED_REVISION);
});
