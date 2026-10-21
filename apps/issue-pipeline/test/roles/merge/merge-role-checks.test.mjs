// @ts-check
// The merge job's checks through a fake RoleContext: CI on exactly the
// authorized head decides whether it merges, waits, stops or goes back to
// review, and a failed CI or local check gets the Reviewer's own
// integration, a check-fix writer session of the integration phase, then
// its own verify, push and receipt.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endCode,
  opNames,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  current,
  HEAD,
  mergeRole,
  REVISION,
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  AFTER_INTEGRATION,
  CI_FAIL,
  FIXED,
  INTEGRATED,
  integrationSessions,
  merging,
  REBASED,
  VERIFIED,
} from "./merge-role-test-kit.mjs";

/** @type {import("../../../src/job/role-context.ts").SessionResult} */
const CANNOT = {
  ok: true,
  reply: { outcome: "cannot", reason: "the e2e runner is down" },
};
const CHECK_FIX_TASK = /Task: `check-fix`/u;
const FAILING_CI = /ci: e2e/u;

test("failing CI gets a Reviewer check-fix session, then its own verify, push and receipt", async () => {
  const { ctx, calls } = merging({
    ops: {
      ...AFTER_INTEGRATION,
      "current-revision": [current(), current({ code: REBASED })],
      "ci-status": [CI_FAIL],
    },
    sessions: [FIXED],
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  const [spec] = integrationSessions(calls);
  assert.match(spec?.task ?? "", CHECK_FIX_TASK);
  assert.match(spec?.task ?? "", FAILING_CI);
  assert.ok(!opNames(calls).includes("merge"));
  assert.ok(!opNames(calls).includes("sync-base"));
  assert.deepEqual(state.integration, {
    reviewed: REVISION,
    revision: INTEGRATED,
  });
  assert.equal(state.counts.syncs, 1);
});

test("a fix session that can't fix the checks stops with check-fixes, pushing nothing", async () => {
  const { ctx, calls } = merging({
    ops: { "ci-status": [CI_FAIL] },
    sessions: [CANNOT],
  });
  assert.equal(endCode(await mergeRole(ctx)), "check-fixes");
  assert.ok(!opNames(calls).includes("push"));
});

test("a failed local check at merge is fixed in the integration phase", async () => {
  const { ctx, calls } = merging({
    state: { verifiedSha: null },
    ops: {
      ...AFTER_INTEGRATION,
      "current-revision": [current(), current({ code: REBASED })],
      verify: [
        {
          pass: false,
          headSha: HEAD,
          checks: [{ id: "test", pass: false, detail: "2 failed" }],
        },
        VERIFIED,
      ],
    },
    sessions: [FIXED],
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(integrationSessions(calls).length, 1);
  assert.equal(state.verifiedSha, REBASED);
  assert.ok(!opNames(calls).includes("ci-status"));
});

test("CI decides: pending waits, none required stops, a moved head goes to review", async () => {
  const cases = [
    { reply: { status: "pending" }, code: "wait", stage: "merge" },
    { reply: { status: "no-checks" }, code: "no-ci", stage: "merge" },
    { reply: { status: "head-changed" }, code: "next", stage: "review" },
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
});

test("failing CI and then failing checks get one integration fix session each before the push", async () => {
  const { ctx, calls } = merging({
    ops: {
      ...AFTER_INTEGRATION,
      "current-revision": [current(), current({ code: REBASED })],
      "ci-status": [CI_FAIL],
      verify: [
        {
          pass: false,
          headSha: HEAD,
          checks: [{ id: "test", pass: false, detail: "still failing" }],
        },
        VERIFIED,
      ],
    },
    sessions: [FIXED, FIXED],
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(integrationSessions(calls).length, 2);
  assert.deepEqual(
    opNames(calls).filter((name) => ["verify", "push"].includes(name)),
    ["verify", "verify", "push"],
  );
  assert.equal(state.verifiedSha, REBASED);
  assert.deepEqual(state.integration?.revision, INTEGRATED);
});
