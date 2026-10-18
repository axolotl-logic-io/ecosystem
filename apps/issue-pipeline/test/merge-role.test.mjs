// @ts-check
// The merge role through a fake RoleContext: no model session ever; a merge
// and a publish only of the exact approved revision, read fresh right before
// each; changed inputs to the author, a changed head (its own clean rebase
// included) to review, conflicts and failed checks to implement, all counted
// against maxSyncs; the merge queue and the head match passed to the merge
// op; and the completion saved before the finish op.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvedReview,
  assertFreshBefore,
  cfg,
  current,
  fakeContext,
  gherkinComment,
  HEAD,
  INPUTS,
  issueState,
  MERGE_COMMIT,
  mergeRole,
  opNames,
  opPayloads,
  PR,
  REVISION,
  savesOf,
  sessionsOf,
  stateOf,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";

const REBASED = "1".repeat(40);
const MOVED = "f".repeat(40);
const QUEUE = [7, 12];
const MERGED_PR = { number: PR, state: "MERGED", mergeCommit: MERGE_COMMIT };
// After the merge, current-revision gives the merge commit as the code.
const AFTER_MERGE = current({ code: MERGE_COMMIT }, MERGED_PR);
const MUTATIONS = ["merge", "publish", "finish-wiki", "sync-base", "wiki-sync"];

const WIKI_UNCHANGED = { conflict: false, changed: false, headSha: WIKI };
const WIKI_PASS = { pass: true, checks: [] };
const CI_PASS = { status: "pass", checks: ["ci"] };
const PUBLISHED = { published: true, sha: WIKI, commits: [`${WIKI.slice(0, 7)} Chats`] };

/**
 * @param {{
 *   state?: Partial<import("../src/state.ts").IssueState>,
 *   ops?: Record<string, unknown[]>,
 *   gherkin?: ReturnType<typeof gherkinComment> | null,
 *   config?: Record<string, unknown>,
 * }} [script]
 */
function merging(script = {}) {
  return fakeContext({
    stage: "merge",
    state: issueState({ stage: "merge", review: approvedReview(), ...script.state }),
    gherkin: script.gherkin,
    mergeQueue: QUEUE,
    config: script.config,
    ops: {
      "current-revision": [current(), current(), AFTER_MERGE],
      "wiki-sync": [WIKI_UNCHANGED],
      "wiki-check": [WIKI_PASS],
      "ci-status": [CI_PASS],
      merge: [{ merged: true, mergeCommit: MERGE_COMMIT }],
      publish: [PUBLISHED],
      "finish-wiki": [{}],
      ...script.ops,
    },
  });
}

/** @param {import("./reviewer-and-merge-role-kit.mjs").fakeContext extends (...a: any) => infer R ? R["calls"] : never} calls */
function mutationsOf(calls) {
  return opNames(calls).filter((name) => MUTATIONS.includes(name));
}

test("an approved revision merges with its head matched, then publishes exactly the reviewed wiki", async () => {
  const { ctx, calls } = merging();
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, { code: MERGE_COMMIT, wiki: WIKI, inputs: INPUTS });
  const [merge] = opPayloads(calls, "merge");
  assert.equal(merge.expectedSha, HEAD);
  assert.deepEqual(merge.revision, REVISION);
  assert.deepEqual(merge.mergeQueue, QUEUE);
  assert.equal(merge.state.pr, PR);
  const [publish] = opPayloads(calls, "publish");
  assert.equal(publish.expectedWiki, WIKI);
  assert.deepEqual(publish.revision, REVISION);
  assertFreshBefore(calls, "merge");
  assertFreshBefore(calls, "publish");
  // The merge receipt is saved before the publish, and the completion before
  // the finish op labels and closes the issue.
  const saves = savesOf(calls);
  assert.equal(saves.length, 2);
  assert.ok(saves[0]?.log.at(-1)?.includes(MERGE_COMMIT));
  const order = calls.map((call) => (call.kind === "op" ? call.name : call.kind));
  assert.ok(order.indexOf("save") < order.indexOf("publish"));
  assert.ok(order.lastIndexOf("save") < order.indexOf("finish-wiki"));
  assert.equal(saves[1]?.stage, "done");
  assert.deepEqual(opPayloads(calls, "finish-wiki")[0]?.state, saves[1]);
});

test("no approval for the current revision goes to review without a mutation", async () => {
  for (const review of [
    approvedReview({ revision: { ...REVISION, code: MOVED } }),
    approvedReview({ revision: { ...REVISION, wiki: MOVED } }),
    approvedReview({ verdict: null }),
    approvedReview({ verdict: "changes" }),
  ]) {
    const { ctx, calls } = merging({ state: { review } });
    const state = stateOf(await mergeRole(ctx), "next");
    assert.equal(state.stage, "review");
    assert.equal(state.review.verdict, null);
    assert.deepEqual(state.review.revision, review.revision);
    assert.deepEqual(opNames(calls), ["current-revision"]);
  }
});

test("inputs the Gherkin predates go to the author before anything merges", async () => {
  const { ctx, calls } = merging({ gherkin: gherkinComment({ inputs: "8".repeat(64) }) });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.deepEqual(mutationsOf(calls), []);
});

test("inputs that change after the checks hold the merge back", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ inputs: "9".repeat(64) })] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.deepEqual(mutationsOf(calls), ["wiki-sync"]);
});

test("a head that changes after the checks goes to review, not to merge", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ code: MOVED })] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.ok(!opNames(calls).includes("merge"));
});

test("an unverified head is verified first, and a failed verify goes to implement", async () => {
  const { ctx, calls } = merging({
    state: { verifiedSha: null },
    ops: {
      verify: [{ pass: false, headSha: HEAD, checks: [{ id: "test", pass: false, detail: "2 failed" }] }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.deepEqual(state.mergeReturn, { reason: "retest", detail: "test: 2 failed", codeMerged: false });
  assert.equal(state.counts.syncs, 1);
  assert.ok(!opNames(calls).includes("merge"));
});

test("CI decides: failing goes to implement, pending waits, none required stops, a moved head reviews", async () => {
  const cases = [
    { reply: { status: "fail", failing: ["e2e"], logPath: "/run/ci.log" }, kind: "next", stage: "implement" },
    { reply: { status: "pending" }, kind: "wait", stage: "merge" },
    { reply: { status: "no-checks", checks: [] }, kind: "stop", stage: "merge" },
    { reply: { status: "head-changed", headSha: MOVED }, kind: "next", stage: "review" },
  ];
  for (const { reply, kind, stage } of cases) {
    const { ctx, calls } = merging({ ops: { "ci-status": [reply] } });
    const end = await mergeRole(ctx);
    const state = stateOf(end, /** @type {any} */ (kind));
    assert.equal(state.stage, stage);
    assert.ok(!opNames(calls).includes("merge"));
    if (end.kind === "stop") {
      assert.equal(end.code, "no-ci");
    }
  }
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  assert.deepEqual(opPayloads(calls, "ci-status")[0], { pr: PR, expectedSha: HEAD });
});

test("a queued merge waits at merge, publishing nothing", async () => {
  const { ctx, calls } = merging({
    ops: { merge: [{ merged: false, reason: "queued", waitingFor: 12, waitingForPr: 88 }] },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.stage, "merge");
  assert.deepEqual(mutationsOf(calls), ["wiki-sync", "merge"]);
});

test("a branch behind its base is rebased, verified and reviewed again, never merged on the old approval", async () => {
  const { ctx, calls } = merging({
    ops: {
      merge: [{ merged: false, reason: "behind" }],
      "sync-base": [{ changed: true, conflict: false, headSha: REBASED, codeChanged: true, wikiAhead: 1 }],
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

test("a rebase conflict goes to implement, counted once", async () => {
  const { ctx } = merging({
    ops: {
      merge: [{ merged: false, reason: "conflict" }],
      "sync-base": [{ changed: false, conflict: true, inRebase: false, conflicts: ["src/chat.ts"], baseSha: MOVED }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "implement");
  assert.equal(state.mergeReturn?.reason, "conflict");
  assert.ok(state.mergeReturn?.detail.includes("src/chat.ts"));
  assert.equal(state.counts.syncs, 1);
});

test("returns are allowed for exactly maxSyncs, then stop before rebasing", async () => {
  assert.equal(cfg.maxSyncs, 3);
  const behind = { merge: [{ merged: false, reason: "behind" }] };
  const last = merging({
    state: { counts: { conflictFixes: 0, syncs: 2 } },
    ops: {
      ...behind,
      "sync-base": [{ changed: true, conflict: false, headSha: REBASED }],
      verify: [{ pass: true, headSha: REBASED, checks: [] }],
    },
  });
  assert.equal(stateOf(await mergeRole(last.ctx), "next").counts.syncs, 3);
  const past = merging({ state: { counts: { conflictFixes: 0, syncs: 3 } }, ops: behind });
  const end = await mergeRole(past.ctx);
  stateOf(end, "stop");
  assert.ok(end.kind === "stop" && end.code === "sync-limit");
  assert.ok(!opNames(past.calls).includes("sync-base"));
  const checks = merging({
    state: { counts: { conflictFixes: 0, syncs: 3 } },
    ops: { "ci-status": [{ status: "fail", failing: ["e2e"], logPath: "/run/ci.log" }] },
  });
  const stopped = await mergeRole(checks.ctx);
  assert.ok(stopped.kind === "stop" && stopped.code === "check-fixes");
});

test("the wiki: a moved head reviews, a conflict is aborted for implement, a failed check implements", async () => {
  const moved = merging({ ops: { "wiki-sync": [{ conflict: false, changed: true, headSha: MOVED }] } });
  const reviewed = stateOf(await mergeRole(moved.ctx), "next");
  assert.equal(reviewed.stage, "review");
  assert.equal(reviewed.counts.syncs, 1);
  const conflict = merging({
    ops: {
      "wiki-sync": [{ conflict: true, inRebase: true, conflicts: ["Chats.md"], baseSha: MOVED, branch: "master" }],
      "finish-wiki-sync": [{ resolved: false, reason: "aborted" }],
    },
  });
  const conflicted = stateOf(await mergeRole(conflict.ctx), "next");
  assert.equal(conflicted.stage, "implement");
  assert.equal(conflicted.mergeReturn?.reason, "wiki-conflict");
  assert.equal(opPayloads(conflict.calls, "finish-wiki-sync")[0]?.abort, true);
  const broken = merging({
    ops: { "wiki-check": [{ pass: false, checks: [{ id: "link", pass: false, detail: "Chats links Nowhere" }] }] },
  });
  const failed = stateOf(await mergeRole(broken.ctx), "next");
  assert.equal(failed.mergeReturn?.reason, "wiki-check");
  for (const { calls } of [moved, conflict, broken]) {
    assert.ok(!opNames(calls).includes("merge"));
  }
});

test("GitHub's refusal stops with merge-refused; a merged reply with no merge commit is an error", async () => {
  const refused = merging({ ops: { merge: [{ merged: false, reason: "merge refused: protected" }] } });
  const end = await mergeRole(refused.ctx);
  assert.ok(end.kind === "stop" && end.code === "merge-refused");
  const blind = merging({ ops: { merge: [{ merged: true, byHand: true }] } });
  await assert.rejects(mergeRole(blind.ctx), /merge: unexpected reply/u);
  assert.ok(!opNames(blind.calls).includes("publish"));
});

test("after its own merge, a wiki that moved waits for review instead of publishing", async () => {
  const { ctx, calls } = merging({
    ops: {
      "current-revision": [current(), current(), current({ code: MERGE_COMMIT, wiki: MOVED }, MERGED_PR)],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.ok(!opNames(calls).includes("publish"));
  assert.ok(savesOf(calls)[0]?.log.at(-1)?.includes(MERGE_COMMIT));
});

test("a finish that fails leaves the completion saved for a retry", async () => {
  const { ctx, calls } = merging({
    ops: { "finish-wiki": [() => Promise.reject(new Error("gh: network"))] },
  });
  await assert.rejects(mergeRole(ctx), /network/u);
  const saved = savesOf(calls).at(-1);
  assert.equal(saved?.stage, "done");
  assert.deepEqual(saved?.merged, { code: MERGE_COMMIT, wiki: WIKI, inputs: INPUTS });
});

test("a refused publish waits and records no completion", async () => {
  const { ctx, calls } = merging({ ops: { publish: [{ published: false, reason: "wiki-behind" }] } });
  stateOf(await mergeRole(ctx), "wait");
  assert.ok(!opNames(calls).includes("finish-wiki"));
  assert.ok(savesOf(calls).every((saved) => saved.stage !== "done"));
});

const CODE_MERGED = { codeMerged: { pr: PR, sha: MERGE_COMMIT } };
const MERGED_REVISION = { code: MERGE_COMMIT, wiki: WIKI, inputs: INPUTS };

test("after a confirmed code merge, only the reviewed wiki is verified, checked and published", async () => {
  const { ctx, calls } = merging({
    state: { ...CODE_MERGED, verifiedSha: HEAD, review: approvedReview({ revision: MERGED_REVISION }) },
    ops: {
      "current-revision": [AFTER_MERGE, AFTER_MERGE],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, MERGED_REVISION);
  assert.ok(!opNames(calls).includes("merge"));
  assert.deepEqual(opPayloads(calls, "verify")[0], CODE_MERGED);
  assert.equal(opPayloads(calls, "publish")[0]?.expectedWiki, WIKI);
  assertFreshBefore(calls, "publish");
});

test("a code merge needs a review of the merge commit, and GitHub's confirmation", async () => {
  const stale = merging({
    state: { ...CODE_MERGED },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const reviewed = stateOf(await mergeRole(stale.ctx), "next");
  assert.equal(reviewed.stage, "review");
  assert.deepEqual(mutationsOf(stale.calls), []);
  const unconfirmed = merging({
    state: { ...CODE_MERGED, review: approvedReview({ revision: MERGED_REVISION }) },
    ops: { "current-revision": [current({ code: MERGE_COMMIT })] },
  });
  const end = await mergeRole(unconfirmed.ctx);
  assert.ok(end.kind === "stop" && end.code === "error");
  assert.deepEqual(mutationsOf(unconfirmed.calls), []);
});

test("a change that lives only in the wiki publishes with no code merge", async () => {
  const { ctx, calls } = merging({
    state: { pr: null, flows: { code: false, wiki: true } },
    ops: { "current-revision": [current({}, null), current({}, null)] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, { ...REVISION, code: null });
  assert.ok(!opNames(calls).includes("merge"));
  assertFreshBefore(calls, "publish");
});
