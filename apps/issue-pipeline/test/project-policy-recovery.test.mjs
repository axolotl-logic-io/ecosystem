// @ts-check
// A current policy can neither check nor review a confirmed historical result
// after Land (#185), nor rewrite its authority: it stops read-only.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_MERGED,
  MERGED_PR,
  LEGACY_UNBOUND_MERGED_REVISION as MERGED_REVISION,
  legacyUnboundMerging as merging,
} from "./roles/merge/merge-role-test-kit.mjs";
import {
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "./roles/reviewer-and-merge-role-calls-test-kit.mjs";
import {
  COMMENT_ID,
  current,
  gherkinComment,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  LEGACY_UNBOUND_REVISION as REVISION,
} from "./roles/reviewer-and-merge-role-test-kit.mjs";

const { policyRevision } = await import("../src/project-policy.ts");
const POLICY = policyRevision(merging().ctx.cfg).policy;
const RESULT = { ...MERGED_REVISION, policy: POLICY };
const FRESH = current(RESULT, MERGED_PR);
const FORBIDDEN = ["merge", "push", "sync-base", "ready-pr"];
const READ_ONLY_RECONCILIATION = /read-only reconciliation is required/u;

/** Whether `end` stops for read-only reconciliation. @param {import("../src/job/role-context.ts").RoleEnd} end */
function readOnlyStop(end) {
  return (
    end.kind === "stop" &&
    end.code === "error" &&
    READ_ONLY_RECONCILIATION.test(end.reason)
  );
}
const HISTORICAL = {
  ...CODE_MERGED,
  merged: MERGED_REVISION,
  mergeAttempt: {
    repo: merging().ctx.cfg.repo,
    pr: MERGED_PR.number,
    target: merging().ctx.cfg.baseBranch,
    branch: "agent/issue-7",
    authorized: REVISION,
    hardened: REVISION,
    integration: null,
    result: MERGED_REVISION.code,
    reads: 1,
  },
};

for (const stage of /** @type {const} */ (["merge", "done"])) {
  test(`${stage} recovery of a historical result stops read-only: no current-policy suite, Security or rebinding`, async () => {
    const { ctx, calls } = merging({
      state: { ...HISTORICAL, stage },
      ops: { "current-revision": [FRESH, FRESH] },
    });
    const before = structuredClone(ctx.state);
    const end = await mergeRole(ctx);
    assert.ok(readOnlyStop(end));
    const stopped = stateOf(end, "stop");
    assert.deepEqual(stopped.merged, before.merged);
    assert.deepEqual(stopped.hardened, before.hardened);
    assert.deepEqual(stopped.mergeAttempt, before.mergeAttempt);
    assert.deepEqual(stopped.codeMerged, before.codeMerged);
    assert.equal(stopped.security, null);
    assert.equal(opNames(calls).includes("verify"), false);
    assert.ok(
      opNames(calls).every((name) => ![...FORBIDDEN, "finish"].includes(name)),
    );
    assert.equal(sessionsOf(calls).length, 0);
    assert.ok(
      savesOf(calls).every(
        (saved) =>
          JSON.stringify(saved.mergeAttempt) ===
          JSON.stringify(before.mergeAttempt),
      ),
    );
  });
}

for (const stage of /** @type {const} */ (["merge", "done"])) {
  test(`${stage} policy drift cannot reroll a same-content historical Security rejection`, async () => {
    const security = {
      revision: MERGED_REVISION,
      commentId: COMMENT_ID,
      finding: {
        category: /** @type {const} */ ("rights"),
        reason: "private data is exposed",
      },
    };
    const { ctx, calls } = merging({
      state: { ...HISTORICAL, stage, security },
      ops: { "current-revision": [FRESH] },
    });
    const end = await mergeRole(ctx);
    assert.equal(end.kind, "stop");
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "rights");
    assert.deepEqual(end.state.security, security);
    assert.equal(sessionsOf(calls).length, 0);
    assert.deepEqual(savesOf(calls), []);
    assert.equal(opNames(calls).includes("finish"), false);
  });
}

const UNPROVEN = [
  { name: "no own receipt", state: { merged: null, mergeAttempt: null } },
  { name: "no original authorization", state: { hardened: null } },
  {
    name: "another PR",
    at: current(RESULT, { ...MERGED_PR, number: MERGED_PR.number + 1 }),
  },
  {
    name: "another PR head",
    at: current(RESULT, { ...MERGED_PR, headSha: MOVED }),
  },
  {
    name: "another merge",
    at: current(RESULT, { ...MERGED_PR, mergeCommit: MOVED }),
  },
  {
    name: "legacy wiki mismatch",
    state: { merged: { ...MERGED_REVISION, wiki: MOVED } },
  },
  { name: "policy forged onto original receipt", state: { merged: RESULT } },
];
for (const invalid of UNPROVEN) {
  test(`current policy cannot recover ${invalid.name}`, async () => {
    const { ctx, calls } = merging({
      state: { ...HISTORICAL, ...invalid.state },
      ops: { "current-revision": [invalid.at ?? FRESH] },
    });
    const end = await mergeRole(ctx);
    assert.ok(end.kind !== "deferred");
    assert.notEqual(end.state.stage, "done");
    assert.equal(sessionsOf(calls).length, 0);
    assert.ok(
      opNames(calls).every((name) => ![...FORBIDDEN, "finish"].includes(name)),
    );
  });
}

test("changed trusted inputs do not borrow the historical result or Security", async () => {
  const moved = current({ ...RESULT, inputs: NEW_INPUTS }, MERGED_PR);
  const { ctx, calls } = merging({
    state: HISTORICAL,
    gherkin: gherkinComment({ inputs: NEW_INPUTS }),
    ops: { "current-revision": [moved] },
  });
  assert.equal(stateOf(await mergeRole(ctx), "next").stage, "author");
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(opNames(calls).includes("verify"), false);
});

test("result-policy movement on a historical result keeps no observation and never finishes or reviews", async () => {
  const changed = current(
    { ...RESULT, policy: "f".repeat(POLICY.length) },
    MERGED_PR,
  );
  const { ctx, calls } = merging({
    state: HISTORICAL,
    ops: { "current-revision": [FRESH, changed] },
  });
  const end = await mergeRole(ctx);
  assert.ok(readOnlyStop(end));
  const state = stateOf(end, "stop");
  assert.equal(state.security, null);
  assert.deepEqual(state.merged, MERGED_REVISION);
  assert.deepEqual(state.mergeAttempt, HISTORICAL.mergeAttempt);
  assert.equal(opNames(calls).includes("finish"), false);
  assert.equal(opNames(calls).includes("verify"), false);
  assert.equal(sessionsOf(calls).length, 0);
  assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
});

test("a genuine saved successful old attempt keeps its result receipt, never another merge, and stops without Security", async () => {
  const { ctx, calls } = merging({
    state: { ...HISTORICAL, merged: null },
    ops: {
      "reconcile-merge": [
        {
          merged: true,
          mergeCommit: MERGED_PR.mergeCommit,
          headSha: MERGED_PR.headSha,
        },
      ],
      "current-revision": [FRESH, FRESH],
    },
  });
  const before = structuredClone(ctx.state);
  const end = await mergeRole(ctx);
  assert.ok(readOnlyStop(end));
  const stopped = stateOf(end, "stop");
  assert.deepEqual(stopped.mergeAttempt, before.mergeAttempt);
  assert.deepEqual(stopped.hardened, before.hardened);
  assert.deepEqual(stopped.merged, MERGED_REVISION);
  assert.equal(stopped.security, null);
  assert.equal(opNames(calls).includes("verify"), false);
  assert.ok(
    opNames(calls).every((name) => ![...FORBIDDEN, "finish"].includes(name)),
  );
  assert.equal(sessionsOf(calls).length, 0);
});

test("external merged truth without successful original attempt cannot borrow current-policy authority", async () => {
  const { ctx, calls } = merging({
    state: {
      ...HISTORICAL,
      merged: null,
      mergeAttempt: { ...HISTORICAL.mergeAttempt, result: null },
    },
    ops: {
      "reconcile-merge": [
        {
          merged: true,
          byHand: true,
          mergeCommit: MERGED_PR.mergeCommit,
          headSha: MERGED_PR.headSha,
        },
      ],
    },
  });
  const end = await mergeRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "merge-refused");
  assert.equal(end.state.merged, null);
  assert.equal(sessionsOf(calls).length, 0);
  assert.ok(
    opNames(calls).every((name) => ![...FORBIDDEN, "finish"].includes(name)),
  );
});

test("a historical result stops before current-policy checks, a writer or Security", async () => {
  const { ctx, calls } = merging({
    state: HISTORICAL,
    ops: {
      "current-revision": [FRESH],
      verify: [{ pass: false, headSha: MERGED_PR.mergeCommit, checks: [] }],
    },
  });
  const end = await mergeRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.deepEqual(end.state.merged, MERGED_REVISION);
  assert.deepEqual(end.state.mergeAttempt, HISTORICAL.mergeAttempt);
  assert.equal(opNames(calls).includes("verify"), false);
  assert.equal(sessionsOf(calls).length, 0);
  assert.ok(
    opNames(calls).every((name) => ![...FORBIDDEN, "finish"].includes(name)),
  );
});

test("a historical no-finding receipt is not reusable after policy drift or rebound by retrospective Security", async () => {
  const { ctx, calls } = merging({
    state: {
      ...HISTORICAL,
      security: {
        revision: MERGED_REVISION,
        commentId: COMMENT_ID,
        finding: null,
      },
    },
    ops: { "current-revision": [FRESH, FRESH] },
  });
  const end = await mergeRole(ctx);
  assert.ok(readOnlyStop(end));
  const stopped = stateOf(end, "stop");
  assert.deepEqual(stopped.merged, MERGED_REVISION);
  assert.deepEqual(stopped.security?.revision, MERGED_REVISION);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(opNames(calls).includes("verify"), false);
  assert.ok(
    opNames(calls).every((name) => ![...FORBIDDEN, "finish"].includes(name)),
  );
});
