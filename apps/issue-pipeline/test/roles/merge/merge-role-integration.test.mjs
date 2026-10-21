// @ts-check
// The Reviewer's own integration at merge (src/roles/merge/integration.ts)
// through a fake RoleContext: a branch behind its base is rebased and a
// conflict resolved, in bounded Reviewer writer sessions of the
// integration phase; the result is verified and pushed,
// and its receipt saved before CI runs on it, so the next merge job merges
// the integrated revision with no model review of its own work. Each
// integration counts one sync against `maxSyncs`; a head that moved by
// anything else goes back to review. The check fixes are
// merge-role-checks.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callNames,
  endCode,
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  current,
  LIMITS,
  MOVED,
  mergeRole,
  PR,
  REVISION,
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  AFTER_INTEGRATION,
  CI_FAIL,
  INTEGRATED,
  integrationSessions,
  merging,
  PUSHED,
  REBASED,
} from "./merge-role-test-kit.mjs";

const REBASED_CLEAN = {
  changed: true,
  conflict: false,
  headSha: REBASED,
  codeChanged: true,
};
const CONFLICT_TASK = /Task: `conflict-resolution`/u;
const RECEIPT_WAIT = /waits for its required CI/u;

// current-revision for the checks, before the merge and after the push.
const REVISIONS = [current(), current(), current({ code: REBASED })];
const BEHIND = { merge: [{ merged: false, reason: "behind" }] };

test("a branch behind its base is rebased, checked, pushed and its receipt saved, with no model review", async () => {
  const { ctx, calls } = merging({
    ops: {
      ...BEHIND,
      ...AFTER_INTEGRATION,
      "current-revision": REVISIONS,
      "sync-base": [REBASED_CLEAN],
    },
  });
  const end = await mergeRole(ctx);
  const state = stateOf(end, "wait");
  assert.ok(end.kind === "wait");
  assert.match(end.reason, RECEIPT_WAIT);
  assert.equal(state.stage, "merge");
  assert.deepEqual(state.hardened, REVISION);
  assert.deepEqual(state.integration, {
    reviewed: REVISION,
    revision: INTEGRATED,
  });
  assert.equal(state.headSha, REBASED);
  assert.equal(state.verifiedSha, REBASED);
  assert.equal(state.counts.syncs, 1);
  assert.equal(sessionsOf(calls).length, 0);
  assert.deepEqual(callNames(calls).slice(callNames(calls).indexOf("merge")), [
    "merge",
    "save",
    "sync-base",
    "verify",
    "push",
    "current-revision",
  ]);
  assert.equal(savesOf(calls)[0]?.counts.syncs, 1);
});

test("the next merge job waits for CI on exactly the integrated head, then merges it", async () => {
  const integrated = {
    verifiedSha: REBASED,
    headSha: REBASED,
    integration: { reviewed: REVISION, revision: INTEGRATED },
  };
  const at = current({ code: REBASED });
  const pending = merging({
    state: integrated,
    ops: {
      "current-revision": [at],
      "ci-status": [{ status: "pending" }],
    },
  });
  stateOf(await mergeRole(pending.ctx), "wait");
  assert.deepEqual(firstPayload(pending.calls, "ci-status"), {
    pr: PR,
    expectedSha: REBASED,
  });
  const merged = merging({
    state: integrated,
    ops: {
      "current-revision": [at, at],
      merge: [{ merged: false, reason: "queued" }],
    },
  });
  stateOf(await mergeRole(merged.ctx), "wait");
  const { expectedSha, revision } = firstPayload(merged.calls, "merge");
  assert.equal(expectedSha, REBASED);
  assert.deepEqual(revision, INTEGRATED);
});

test("a rebase conflict gets a Reviewer resolver session of the integration phase, counted once as a sync", async () => {
  const { ctx, calls } = merging({
    ops: {
      ...BEHIND,
      ...AFTER_INTEGRATION,
      "current-revision": REVISIONS,
      "sync-base": [
        {
          changed: false,
          conflict: true,
          inRebase: true,
          conflicts: ["src/chat.ts"],
          baseSha: MOVED,
        },
      ],
      "finish-sync": [{ resolved: true }],
    },
    sessions: [
      { ok: true, reply: { outcome: "conflict-resolved", summary: "both" } },
    ],
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  const [spec] = integrationSessions(calls);
  assert.equal(spec?.agent, "issue-pipeline-reviewer");
  assert.equal(spec?.commits, true);
  assert.match(spec?.task ?? "", CONFLICT_TASK);
  const { baseSha } = firstPayload(calls, "finish-sync");
  assert.equal(baseSha, MOVED);
  assert.equal(state.counts.syncs, 1);
  assert.equal(state.counts.conflictFixes, 1);
  assert.deepEqual(state.integration?.revision, INTEGRATED);
});

test("integrations are allowed for exactly maxSyncs, then stop before rebasing or any session", async () => {
  const spent = { counts: { conflictFixes: 0, syncs: LIMITS.maxSyncs } };
  const last = merging({
    state: { counts: { conflictFixes: 0, syncs: LIMITS.maxSyncs - 1 } },
    ops: {
      ...BEHIND,
      ...AFTER_INTEGRATION,
      "current-revision": REVISIONS,
      "sync-base": [REBASED_CLEAN],
    },
  });
  const counted = stateOf(await mergeRole(last.ctx), "wait");
  assert.equal(counted.counts.syncs, LIMITS.maxSyncs);
  const runs = [
    merging({ state: spent, ops: BEHIND }),
    merging({ state: spent, ops: { "ci-status": [CI_FAIL] } }),
  ];
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    assert.equal(endCode(end), "sync-limit");
    const { calls } = runs[index] ?? { calls: [] };
    assert.ok(!opNames(calls).includes("sync-base"));
    assert.equal(sessionsOf(calls).length, 0);
  }
});

test("a head that moved after the integration's push goes to review, with no receipt", async () => {
  const { ctx } = merging({
    ops: {
      ...BEHIND,
      ...AFTER_INTEGRATION,
      "current-revision": [current(), current(), current({ code: MOVED })],
      "sync-base": [REBASED_CLEAN],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.equal(state.integration, null);
  assert.equal(state.hardened, null);
});

test("a branch push that leaves another head than the verified one stops with no receipt or completion", async () => {
  const { ctx, calls } = merging({
    ops: {
      ...BEHIND,
      ...AFTER_INTEGRATION,
      "current-revision": REVISIONS,
      "sync-base": [REBASED_CLEAN],
      push: [{ ...PUSHED, headSha: MOVED }],
    },
  });
  const end = await mergeRole(ctx);
  assert.equal(endCode(end), "error");
  assert.ok(end.kind === "stop");
  assert.ok(end.reason.includes(MOVED));
  assert.ok(end.reason.includes(REBASED));
  assert.equal(end.state.integration, null);
  assert.ok(savesOf(calls).every((saved) => saved.integration === null));
  assert.deepEqual(firstPayload(calls, "push"), { number: ctx.issue });
  // The only merge attempt is the original refusal that required integration.
  assert.equal(opNames(calls).filter((name) => name === "merge").length, 1);
  assert.ok(!opNames(calls).includes("prepare-review"));
  assert.ok(!opNames(calls).includes("finish"));
  assert.equal(sessionsOf(calls).length, 0);
});
