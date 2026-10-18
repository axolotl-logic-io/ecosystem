// @ts-check
// The Reviewer's hardening and the revision it binds, through a fake
// RoleContext: a head or inputs change during hardening saves nothing and
// posts nothing, a stale Gherkin goes to the author, wiki-only hardening
// after the code merged binds the merge commit and pushes the wiki alone,
// and failures never pass for a hardening.
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
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  current,
  gherkinComment,
  HEAD,
  INPUTS,
  MERGE_COMMIT,
  MOVED,
  NEW_INPUTS,
  PR,
  REVISION,
  reviewerRole,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";
import { hardening, PUSHED, VERIFIED } from "./reviewer-role-test-kit.mjs";

const UNREADABLE_REPLY = /reply is not what the role reads/u;
const HEAD_MOVED = /the next job hardens the new head/u;
const MERGED_SCOPE =
  /Scope: the wiki in `docs\/` only\. The code already merged as PR #90/u;
const WIKI_CHANGE_SCOPE =
  /Scope: the wiki in `docs\/` only\. The change lives only in the wiki/u;
const BRANCH_HEAD = HEAD;

const MERGED_PR = { number: PR, state: "MERGED", mergeCommit: MERGE_COMMIT };
const CODE_MERGED = { pr: PR, sha: MERGE_COMMIT };

test("a head that moved after the push waits, saving and posting nothing", async () => {
  const { ctx, calls } = hardening({
    state: { hardened: REVISION },
    before: current({ wiki: MOVED }),
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

test("after the code merged, wiki-only hardening verifies the merge commit, pushes the wiki alone and binds the merge commit", async () => {
  const merged = current({ code: MERGE_COMMIT }, MERGED_PR);
  const { ctx, calls } = hardening({
    state: { codeMerged: CODE_MERGED },
    before: merged,
    after: merged,
    ops: {
      verify: [{ ...VERIFIED, headSha: MERGE_COMMIT }],
      push: [{ ...PUSHED, headSha: BRANCH_HEAD, codeChanged: false }],
    },
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.match(sessionsOf(calls)[0]?.task ?? "", MERGED_SCOPE);
  const { codeMerged } = firstPayload(calls, "verify");
  assert.deepEqual(codeMerged, CODE_MERGED);
  const { wikiOnly } = firstPayload(calls, "push");
  assert.equal(wikiOnly, true);
  assert.ok(!opNames(calls).includes("ready-pr"));
  assert.equal(state.stage, "merge");
  assert.equal(state.verifiedSha, MERGE_COMMIT);
  assert.deepEqual(state.hardened, {
    code: MERGE_COMMIT,
    wiki: WIKI,
    inputs: INPUTS,
  });
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

test("a change that lives only in the wiki is hardened in docs/, pushed alone and noted on the issue", async () => {
  const { ctx, calls } = hardening({
    state: { pr: null, flows: { code: false, wiki: true } },
    before: current({}, null),
    after: current({}, null),
    ops: { push: [{ ...PUSHED, codeChanged: false }] },
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.match(sessionsOf(calls)[0]?.task ?? "", WIKI_CHANGE_SCOPE);
  const { wikiOnly } = firstPayload(calls, "push");
  assert.equal(wikiOnly, true);
  assert.equal(postsOf(calls)[0]?.on, "issue");
  assert.ok(!opNames(calls).includes("ready-pr"));
  assert.equal(state.stage, "merge");
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
