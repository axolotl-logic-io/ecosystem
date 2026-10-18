// @ts-check
// The merge role's returns through a fake RoleContext: a failed verify, CI
// or wiki check and a conflict go to implement, a moved head (its own clean
// rebase included) to review, each counted as one sync against maxSyncs and
// never as a conflict fix, which only the implementor's resolver counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { merging, REBASED } from "./merge-role-test-kit.mjs";
import {
  endCode,
  firstPayload,
  opNames,
  opPayloads,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  HEAD,
  LIMITS,
  MOVED,
  mergeRole,
  PR,
} from "./reviewer-and-merge-role-kit.mjs";

const CI_FAIL = { status: "fail", failing: ["e2e"], logPath: "/run/ci.log" };

test("an unverified head is verified first, and a failed verify goes to implement", async () => {
  const { ctx, calls } = merging({
    state: { verifiedSha: null },
    ops: {
      verify: [
        {
          pass: false,
          headSha: HEAD,
          checks: [{ id: "test", pass: false, detail: "2 failed" }],
        },
      ],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.deepEqual(state.mergeReturn, {
    reason: "retest",
    detail: "test: 2 failed",
    codeMerged: false,
  });
  assert.equal(state.counts.syncs, 1);
  assert.equal(state.counts.conflictFixes, 0);
  assert.ok(!opNames(calls).includes("merge"));
});

test("CI decides: failing goes to implement, pending waits, none required stops, a moved head reviews", async () => {
  const cases = [
    { reply: CI_FAIL, code: "next", stage: "implement" },
    { reply: { status: "pending" }, code: "wait", stage: "merge" },
    {
      reply: { status: "no-checks", checks: [] },
      code: "no-ci",
      stage: "merge",
    },
    {
      reply: { status: "head-changed", headSha: MOVED },
      code: "next",
      stage: "review",
    },
  ];
  const runs = cases.map(({ reply }) =>
    merging({ ops: { "ci-status": [reply] } }),
  );
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    assert.equal(endCode(end), cases[index]?.code);
    assert.ok(end.kind !== "deferred");
    assert.equal(end.state.stage, cases[index]?.stage);
    assert.ok(!opNames(runs[index]?.calls ?? []).includes("merge"));
  }
  const passing = merging();
  await mergeRole(passing.ctx);
  assert.deepEqual(opPayloads(passing.calls, "ci-status")[0], {
    pr: PR,
    expectedSha: HEAD,
  });
});

test("a branch behind its base is rebased, verified and reviewed again, never merged on the old approval", async () => {
  const { ctx, calls } = merging({
    ops: {
      merge: [{ merged: false, reason: "behind" }],
      "sync-base": [
        {
          changed: true,
          conflict: false,
          headSha: REBASED,
          codeChanged: true,
          wikiAhead: 1,
        },
      ],
      verify: [{ pass: true, headSha: REBASED, checks: [] }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.equal(state.review.verdict, null);
  assert.equal(state.headSha, REBASED);
  assert.equal(state.verifiedSha, REBASED);
  assert.equal(state.counts.syncs, 1);
  assert.equal(opPayloads(calls, "merge").length, 1);
  assert.ok(!opNames(calls).includes("publish"));
});

test("a rebase conflict goes to implement, counted once as a sync and never as a conflict fix", async () => {
  const { ctx } = merging({
    ops: {
      merge: [{ merged: false, reason: "conflict" }],
      "sync-base": [
        {
          changed: false,
          conflict: true,
          inRebase: false,
          conflicts: ["src/chat.ts"],
          baseSha: MOVED,
        },
      ],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.equal(state.mergeReturn?.reason, "conflict");
  assert.ok(state.mergeReturn?.detail.includes("src/chat.ts"));
  assert.equal(state.counts.syncs, 1);
  assert.equal(state.counts.conflictFixes, 0);
});

test("returns are allowed for exactly maxSyncs, then stop before rebasing", async () => {
  const behind = { merge: [{ merged: false, reason: "behind" }] };
  const spent = { counts: { conflictFixes: 0, syncs: LIMITS.maxSyncs } };
  const last = merging({
    state: { counts: { conflictFixes: 0, syncs: LIMITS.maxSyncs - 1 } },
    ops: {
      ...behind,
      "sync-base": [{ changed: true, conflict: false, headSha: REBASED }],
      verify: [{ pass: true, headSha: REBASED, checks: [] }],
    },
  });
  assert.equal(
    stateOf(await mergeRole(last.ctx), "next").counts.syncs,
    LIMITS.maxSyncs,
  );
  const past = merging({ state: spent, ops: behind });
  const end = await mergeRole(past.ctx);
  assert.equal(endCode(end), "sync-limit");
  assert.ok(!opNames(past.calls).includes("sync-base"));
  const checks = merging({ state: spent, ops: { "ci-status": [CI_FAIL] } });
  assert.equal(endCode(await mergeRole(checks.ctx)), "check-fixes");
  const conflict = merging({
    state: spent,
    ops: {
      "wiki-sync": [{ conflict: true, conflicts: ["Chats.md"] }],
      "finish-wiki-sync": [{}],
    },
  });
  assert.equal(endCode(await mergeRole(conflict.ctx)), "conflict");
});

test("the wiki: a moved head reviews, a conflict is aborted for implement, a failed check implements", async () => {
  const moved = merging({
    ops: { "wiki-sync": [{ conflict: false, changed: true, headSha: MOVED }] },
  });
  const reviewed = stateOf(await mergeRole(moved.ctx), "next");
  assert.equal(reviewed.stage, "review");
  assert.equal(reviewed.counts.syncs, 1);
  const conflict = merging({
    ops: {
      "wiki-sync": [
        {
          conflict: true,
          inRebase: true,
          conflicts: ["Chats.md"],
          baseSha: MOVED,
          branch: "master",
        },
      ],
      "finish-wiki-sync": [{ resolved: false, reason: "aborted" }],
    },
  });
  const conflicted = stateOf(await mergeRole(conflict.ctx), "next");
  assert.equal(conflicted.stage, "implement");
  assert.equal(conflicted.mergeReturn?.reason, "wiki-conflict");
  assert.equal(conflicted.counts.conflictFixes, 0);
  const { abort } = firstPayload(conflict.calls, "finish-wiki-sync");
  assert.equal(abort, true);
  const broken = merging({
    ops: {
      "wiki-check": [
        {
          pass: false,
          checks: [{ id: "link", pass: false, detail: "Chats links Nowhere" }],
        },
      ],
    },
  });
  const failed = stateOf(await mergeRole(broken.ctx), "next");
  assert.equal(failed.mergeReturn?.reason, "wiki-check");
  for (const { calls } of [moved, conflict, broken]) {
    assert.ok(!opNames(calls).includes("merge"));
  }
});
