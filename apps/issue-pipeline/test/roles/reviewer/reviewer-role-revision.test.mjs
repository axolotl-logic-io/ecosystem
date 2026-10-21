// @ts-check
// The Reviewer's hardening and the revision it binds, through a fake
// RoleContext: a head or inputs change during hardening saves nothing and
// posts nothing, a stale Gherkin goes to the author, hardening after the
// code merged binds the merge commit and pushes nothing, and failures never
// pass for a hardening.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endCode,
  firstPayload,
  opNames,
  postsOf,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  cfg,
  current,
  gherkinComment,
  HEAD,
  MERGE_COMMIT,
  MOVED,
  NEW_INPUTS,
  PR,
  REVISION,
  reviewerRole,
  sha,
} from "../reviewer-and-merge-role-test-kit.mjs";
import { hardening, VERIFIED } from "./reviewer-role-test-kit.mjs";

const { policyRevision } = await import("../../../src/project-policy.ts");
const UNREADABLE_REPLY = /reply is not what the role reads/u;
const HEAD_MOVED = /the next job hardens the new head/u;
const MERGED_SCOPE =
  /Scope: none\. The code already merged as PR #90, merge commit `[0-9a-f]+`, which `repo\/` holds: commit nothing\./u;

const MERGED_PR = {
  number: PR,
  state: "MERGED",
  mergeCommit: MERGE_COMMIT,
  headSha: HEAD,
};
const CODE_MERGED = { pr: PR, sha: MERGE_COMMIT };

test("a head that moved after the push waits, saving and posting nothing", async () => {
  const { ctx, calls } = hardening({
    state: { hardened: { ...REVISION, code: sha("8") } },
    before: current(),
    after: current({ code: MOVED }),
  });
  const end = await reviewerRole(ctx);
  assert.ok(end.kind === "wait");
  assert.match(end.reason, HEAD_MOVED);
  assert.equal(savesOf(calls).length, 0);
  assert.equal(postsOf(calls).length, 0);
  assert.ok(!opNames(calls).includes("ready-pr"));
});

test("inputs that changed during hardening send the issue to the author, voiding any hardening", async () => {
  const { ctx, calls } = hardening({
    after: current({ inputs: NEW_INPUTS }),
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.equal(state.hardened, null);
  assert.equal(state.integration, null);
  assert.equal(postsOf(calls).length, 0);
  assert.equal(savesOf(calls).length, 0);
});

test("a Gherkin older than the inputs, or none, goes to the author before any session", async () => {
  const runs = [
    hardening({ gherkin: gherkinComment({ inputs: NEW_INPUTS }) }),
    hardening({ gherkin: null }),
  ];
  const ends = await Promise.all(runs.map(({ ctx }) => reviewerRole(ctx)));
  for (const [at, { calls }] of runs.entries()) {
    const state = stateOf(
      ends[at] ?? { kind: "deferred", error: "none" },
      "next",
    );
    assert.equal(state.stage, "author");
    assert.equal(state.resumeStage, "review");
    assert.deepEqual(opNames(calls), ["current-revision"]);
    assert.equal(sessionsOf(calls).length, 0);
  }
});

test("after the code merged, hardening verifies the merge commit, pushes nothing and binds the merge commit", async () => {
  const merged = current({ code: MERGE_COMMIT }, MERGED_PR);
  const { ctx, calls } = hardening({
    state: { codeMerged: CODE_MERGED },
    before: merged,
    after: merged,
    ops: {
      "prepare-review": [{ headSha: MERGE_COMMIT }],
      verify: [{ ...VERIFIED, headSha: MERGE_COMMIT }],
    },
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.match(sessionsOf(calls)[0]?.task ?? "", MERGED_SCOPE);
  const { codeMerged: prepared } = firstPayload(calls, "prepare-review");
  assert.deepEqual(prepared, CODE_MERGED);
  const { codeMerged } = firstPayload(calls, "verify");
  assert.deepEqual(codeMerged, CODE_MERGED);
  assert.ok(!opNames(calls).includes("push"));
  assert.ok(!opNames(calls).includes("ready-pr"));
  assert.equal(state.stage, "merge");
  assert.equal(state.verifiedSha, MERGE_COMMIT);
  assert.deepEqual(state.hardened, merged.revision);
  assert.equal(state.hardened?.policy, policyRevision(cfg).policy);
});

test("postmerge preparation of a different result refuses a writer and preserves merged provenance", async () => {
  const merged = current({ code: MERGE_COMMIT }, MERGED_PR);
  const { ctx, calls } = hardening({
    state: { codeMerged: CODE_MERGED },
    before: merged,
    ops: { "prepare-review": [{ headSha: HEAD }] },
  });
  const end = await reviewerRole(ctx);
  assert.equal(endCode(end), "error");
  assert.deepEqual(stateOf(end, "stop").codeMerged, CODE_MERGED);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(savesOf(calls).length, 0);
  assert.deepEqual(opNames(calls), ["current-revision", "prepare-review"]);
});

test("a code merge GitHub doesn't confirm stops before any hardening", async () => {
  const { ctx, calls } = hardening({
    state: { codeMerged: CODE_MERGED },
    before: current({ code: MERGE_COMMIT }),
  });
  const end = await reviewerRole(ctx);
  stateOf(end, "stop");
  assert.equal(endCode(end), "error");
  assert.equal(sessionsOf(calls).length, 0);
});

test("a failed session stops with error, and a transient one defers, saving nothing", async () => {
  const failed = hardening({
    sessions: [{ ok: false, transient: false, error: "bad reply" }],
  });
  assert.equal(endCode(await reviewerRole(failed.ctx)), "error");
  const transient = hardening({
    sessions: [{ ok: false, transient: true, error: "429" }],
  });
  assert.equal((await reviewerRole(transient.ctx)).kind, "deferred");
  assert.equal(
    savesOf(failed.calls).length + savesOf(transient.calls).length,
    0,
  );
});

test("an op reply of an unexpected shape is an error, not a hardening", async () => {
  const { ctx, calls } = hardening({ before: { revision: { code: HEAD } } });
  await assert.rejects(reviewerRole(ctx), {
    name: "OpsFailure",
    op: "current-revision",
    message: UNREADABLE_REPLY,
  });
  assert.equal(sessionsOf(calls).length, 0);
});
