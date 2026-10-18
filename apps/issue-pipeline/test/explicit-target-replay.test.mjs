// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codeWrites,
  context,
  current,
  NO_FINDING,
  names,
  ownState,
  postmergeOps,
  result,
  saves,
  WIKI_PASS,
} from "./explicit-target-role-test-kit.mjs";
import { PR, world } from "./explicit-target-world-test-kit.mjs";

const { mergeRole } = await import("../src/roles/merge/merge.ts");
const { recoverOwnMerge } = await import("../src/roles/merge/recovery.ts");
const { afterOwnMerge } = await import("../src/roles/merge/publish.ts");
const { OpsFailure } = await import("../src/job/role-context.ts");
const FALSE_RECEIPT = /GitHub or the wiki no longer match/u;

test("done replay with saved security still reestablishes graph/checks before completion", async () => {
  const w = world();
  const run = context(w, {
    state: {
      ...ownState(w),
      stage: "done",
      verifiedSha: w.merged,
      security: { revision: result(w), commentId: PR, finding: null },
    },
    ops: { ...postmergeOps(w), "current-revision": [current(w, true)] },
  });
  const end = await mergeRole(run.ctx);
  assert.equal(end.kind, "next");
  assert.ok(
    names(run.calls).indexOf("verify") <
      names(run.calls).indexOf("finish-wiki"),
  );
  assert.equal(names(run.calls).includes("session"), false);
  assert.equal(names(run.calls).includes("merge"), false);
});

/** @type {("merge" | "done")[]} */
const REPLAY_STAGES = ["merge", "done"];
for (const stage of REPLAY_STAGES) {
  test(`${stage} replay honors durable exact security rejection before checks or models`, async () => {
    const w = world();
    const run = context(w, {
      state: {
        ...ownState(w),
        stage,
        security: {
          revision: result(w),
          commentId: PR,
          finding: { category: "abuse-risk", reason: "unsafe" },
        },
      },
      ops: { "current-revision": [current(w, true)] },
    });
    const end = await mergeRole(run.ctx);
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "abuse-risk");
    assert.deepEqual(names(run.calls), ["current-revision"]);
  });
}

for (const change of ["head", "merge", "wiki", "pr"]) {
  test(`own recovery refuses ${change} mismatch rather than inventing provenance or invoking checks`, async () => {
    const w = world();
    const fresh = current(w, true);
    if (change === "head") {
      fresh.pr.headSha = w.moved;
    }
    if (change === "merge") {
      fresh.pr.mergeCommit = w.moved;
    }
    if (change === "pr") {
      fresh.pr.number = PR + 1;
    }
    const run = context(w, { state: { ...ownState(w) }, ops: {} });
    if (change === "wiki") {
      run.ctx.state.merged = { ...result(w), wiki: w.moved };
    }
    assert.equal(await recoverOwnMerge(run.ctx, fresh), null);
    assert.deepEqual(run.calls, []);
  });
}

test("postmerge identity mismatch stops with receipt retained instead of reopening a writer", async () => {
  const w = world();
  const fresh = current(w, true);
  fresh.pr.headSha = w.moved;
  const run = context(w, { ops: { "current-revision": [fresh] } });
  const end = await afterOwnMerge(run.ctx, run.ctx.state, {
    authorized: w.revision,
    mergeCommit: w.merged,
  });
  assert.ok(end.kind === "stop");
  assert.match(end.reason, FALSE_RECEIPT);
  assert.equal(end.state.merged?.code, w.merged);
  assert.equal(names(run.calls).includes("session"), false);
});

test("byHand observed during merge is never promoted to a fresh own receipt", async () => {
  const w = world();
  const run = context(w, {
    ops: {
      "current-revision": [current(w), current(w)],
      "wiki-check": [WIKI_PASS],
      "ci-status": [{ status: "pass" }],
      merge: [
        { merged: true, byHand: true, mergeCommit: w.merged, headSha: w.head },
      ],
    },
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "wait");
  assert.equal(end.state.merged, null);
  assert.equal(names(run.calls).includes("session"), false);
  assert.deepEqual(saves(run.calls), []);
});

test("external merged result needs independent postmerge hardening, not original H or codeMerged alone", async () => {
  const w = world();
  const run = context(w, {
    state: { codeMerged: { pr: PR, sha: w.merged } },
    ops: { "current-revision": [current(w, true)] },
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.merged, null);
  assert.equal(end.state.codeMerged?.sha, w.merged);
  assert.deepEqual(names(run.calls), ["current-revision"]);
});

test("independently hardened postmerge M retains external provenance and runs exact checks without merge", async () => {
  const w = world();
  const run = context(w, {
    state: { hardened: result(w), codeMerged: { pr: PR, sha: w.merged } },
    ops: {
      ...postmergeOps(w),
      "current-revision": [
        current(w, true),
        current(w, true),
        current(w, true),
      ],
    },
    sessions: [NO_FINDING],
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "done");
  assert.deepEqual(end.state.hardened, result(w));
  assert.equal(names(run.calls).filter((name) => name === "verify").length, 1);
  assert.equal(names(run.calls).includes("merge"), false);
  assert.deepEqual(codeWrites(run.calls), []);
});

for (const outcome of [
  "204 no fresh own receipt",
  "unconfirmed merge outcome",
]) {
  test(`${outcome} stops without an own receipt, repeat POST or security session`, async () => {
    const w = world();
    const run = context(w, {
      ops: {
        "current-revision": [current(w), current(w)],
        "wiki-check": [WIKI_PASS],
        "ci-status": [{ status: "pass" }],
        merge: [{ merged: false, reason: outcome }],
      },
    });
    const end = await mergeRole(run.ctx);
    assert.ok(end.kind === "stop");
    assert.equal(end.code, "merge-refused");
    assert.equal(end.state.merged, null);
    assert.equal(names(run.calls).filter((name) => name === "merge").length, 1);
    assert.equal(names(run.calls).includes("session"), false);
  });
}

test("unreadable merged verification propagates without losing saved own receipt or running a writer", async () => {
  const w = world();
  const run = context(w, {
    ops: {
      "current-revision": [current(w, true)],
      verify: [new OpsFailure("verify", 1, "unsupported merged result")],
    },
  });
  await assert.rejects(
    afterOwnMerge(run.ctx, run.ctx.state, {
      authorized: w.revision,
      mergeCommit: w.merged,
    }),
    OpsFailure,
  );
  assert.equal(saves(run.calls)[0]?.merged?.code, w.merged);
  assert.equal(names(run.calls).includes("session"), false);
  assert.deepEqual(codeWrites(run.calls), []);
});

test("done replay check failure cannot reuse saved security to complete unchecked M", async () => {
  const w = world();
  const run = context(w, {
    state: {
      ...ownState(w),
      stage: "done",
      verifiedSha: w.merged,
      security: { revision: result(w), commentId: PR, finding: null },
    },
    ops: {
      "current-revision": [current(w, true)],
      verify: [{ pass: false, headSha: w.merged, checks: [] }],
      "wiki-check": [WIKI_PASS],
    },
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.state.merged?.code, w.merged);
  assert.equal(end.state.security?.finding, null);
  assert.equal(names(run.calls).includes("finish-wiki"), false);
  assert.equal(names(run.calls).includes("session"), false);
  assert.deepEqual(codeWrites(run.calls), []);
});
