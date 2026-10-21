// @ts-check
// A current policy can check a confirmed historical result, not rewrite its authority.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
} from "./merge-role-test-kit.mjs";
import {
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  current,
  gherkinComment,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

const { policyRevision } = await import("../src/project-policy.ts");
const POLICY = policyRevision(merging().ctx.cfg).policy;
const RESULT = { ...MERGED_REVISION, policy: POLICY };
const FRESH = current(RESULT, MERGED_PR);
const FORBIDDEN = ["merge", "push", "sync-base", "ready-pr"];
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
  test(`${stage} recovery checks and readonly-reviews current policy without rebinding history`, async () => {
    const { ctx, calls } = merging({
      state: { ...HISTORICAL, stage },
      ops: { "current-revision": [FRESH, FRESH] },
    });
    const before = structuredClone(ctx.state);
    const done = stateOf(await mergeRole(ctx), "next");
    assert.equal(done.stage, "done");
    assert.deepEqual(done.merged, before.merged);
    assert.deepEqual(done.hardened, before.hardened);
    assert.deepEqual(done.mergeAttempt, before.mergeAttempt);
    assert.deepEqual(done.codeMerged, before.codeMerged);
    assert.deepEqual(done.security, {
      revision: RESULT,
      commentId: COMMENT_ID,
      finding: null,
    });
    assert.deepEqual(firstPayload(calls, "verify"), {
      number: ctx.issue,
      codeMerged: CODE_MERGED.codeMerged,
    });
    assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
    assert.deepEqual(
      sessionsOf(calls).map(({ commits, phase }) => ({ commits, phase })),
      [{ commits: false, phase: "security-review" }],
    );
    assert.ok(
      savesOf(calls).every(
        (saved) =>
          JSON.stringify(saved.mergeAttempt) ===
          JSON.stringify(before.mergeAttempt),
      ),
    );
    const { state: finished } = firstPayload(calls, "finish");
    assert.deepEqual(finished, done);
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

test("result-policy movement during readonly Security discards the observation and never finishes", async () => {
  const changed = current(
    { ...RESULT, policy: "f".repeat(POLICY.length) },
    MERGED_PR,
  );
  const { ctx, calls } = merging({
    state: HISTORICAL,
    ops: { "current-revision": [FRESH, changed] },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.security, null);
  assert.deepEqual(state.merged, MERGED_REVISION);
  assert.deepEqual(state.mergeAttempt, HISTORICAL.mergeAttempt);
  assert.equal(opNames(calls).includes("finish"), false);
  assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
});

test("a genuine saved successful old attempt gets a new result observation, never another merge", async () => {
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
  const done = stateOf(await mergeRole(ctx), "next");
  assert.deepEqual(done.mergeAttempt, before.mergeAttempt);
  assert.deepEqual(done.hardened, before.hardened);
  assert.deepEqual(done.merged, MERGED_REVISION);
  assert.deepEqual(done.security?.revision, RESULT);
  assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
  assert.ok(sessionsOf(calls).every((spec) => spec.commits === false));
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

test("current-policy checks that fail on a historical result stop without a writer or Security", async () => {
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
  assert.equal(sessionsOf(calls).length, 0);
  assert.ok(
    opNames(calls).every((name) => ![...FORBIDDEN, "finish"].includes(name)),
  );
});

test("a historical no-finding receipt is not reusable after policy drift", async () => {
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
  const done = stateOf(await mergeRole(ctx), "next");
  assert.deepEqual(done.merged, MERGED_REVISION);
  assert.deepEqual(done.security?.revision, RESULT);
  assert.equal(sessionsOf(calls).length, 1);
  assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
});
