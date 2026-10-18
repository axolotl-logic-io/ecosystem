// @ts-check
// A change that lives only in the wiki, across the roles: the implementor's
// own end state, as the next claims hand it on, goes through an approving
// review and the merge to a publish and finish, with no code merge. The
// implementor closes its draft PR, so no PR is the issue's any more; the
// fake current-revision answers as the real op reads the PR (revision.ts
// issuePullRequest): the state's PR by number, else the branch's open PR,
// of which there is none once the draft is closed. The claim keeps the same
// PR the same way, so each role's end state is the next role's state.
// reviewer-and-merge-role-kit sets a temporary HOME and root before any
// pipeline module loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FINISHED } from "./merge-role-test-kit.mjs";
import {
  firstPayload,
  opNames,
  postsOf,
  savesOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  current,
  fakeContext,
  HEAD,
  issueState,
  mergeRole,
  PR,
  REVISION,
  reviewerRole,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";
import { verdict } from "./reviewer-role-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);

const WIKI_PAGE = "wiki/Chats.md";
// The implementor's ops for a branch whose only commits are the wiki's.
const IMPLEMENT_OPS = {
  "start-pr": [{ pr: PR, headSha: HEAD }],
  "sync-base": [{ changed: false, conflict: false, headSha: HEAD }],
  "wiki-sync": [{ changed: false, conflict: false, headSha: WIKI }],
  verify: [{ pass: true, headSha: HEAD, changedFiles: [], checks: [] }],
  "wiki-check": [{ pass: true, checks: [] }],
  "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: false, wikiAhead: 1 }],
  "close-pr": [{ pr: PR, closed: true }],
};
const PREPARED = {
  headSha: HEAD,
  diffPath: "/run/review-r1/diff.patch",
  bundlePath: "/run/review-r1/bundle.md",
  changedFiles: [WIKI_PAGE],
};
const WIKI_UNCHANGED = { conflict: false, changed: false, headSha: WIKI };
const PUBLISHED = { published: true, sha: WIKI, commits: [] };
// The ops that merge code, which a wiki-only change never runs.
const CODE_MERGE_OPS = ["merge", "ci-status", "sync-base"];

/**
 * current-revision as the real op answers it for the state it is given:
 * the saved PR, now closed, or no PR when the state names none.
 * @param {{ state: import("../src/state.ts").IssueState }} payload
 */
function currentFor({ state }) {
  if (state.pr === null) {
    return current({}, null);
  }
  return current({}, { number: state.pr, state: "CLOSED", mergeCommit: null });
}

/**
 * The implementor's end, and the calls it made, for a branch that open-pr
 * reports as `changes` (a wiki-only change by default).
 * @param {{ codeChanged: boolean, wikiAhead: number }} [changes]
 * @param {Record<string, unknown[]>} [ops] replies over IMPLEMENT_OPS'
 */
async function implemented(
  changes = { codeChanged: false, wikiAhead: 1 },
  ops = {},
) {
  const { ctx, calls } = fakeContext({
    stage: "implement",
    state: issueState({
      stage: "implement",
      pr: null,
      headSha: null,
      verifiedSha: null,
      flows: null,
    }),
    ops: {
      ...IMPLEMENT_OPS,
      "open-pr": [{ pr: PR, headSha: HEAD, ...changes }],
      ...ops,
    },
    sessions: [
      { ok: true, reply: { outcome: "done", summary: "Documents chats" } },
    ],
  });
  return { end: await implementorRole(ctx), calls };
}

test("the implementor's wiki-only end names no PR, so review and merge publish it with no code merge", async () => {
  const implementing = await implemented();
  assert.equal(opNames(implementing.calls).at(-1), "close-pr");
  const afterImplement = stateOf(implementing.end, "next");
  assert.equal(afterImplement.stage, "review");
  assert.equal(afterImplement.pr, null);
  assert.deepEqual(afterImplement.flows, { code: false, wiki: true });

  const reviewing = fakeContext({
    stage: "review",
    state: afterImplement,
    ops: {
      "current-revision": [currentFor, currentFor],
      "prepare-review": [PREPARED],
    },
    sessions: [verdict()],
  });
  const afterReview = stateOf(await reviewerRole(reviewing.ctx), "next");
  assert.equal(postsOf(reviewing.calls)[0]?.on, "issue");
  assert.equal(afterReview.stage, "merge");
  assert.equal(afterReview.review.verdict, "approve");
  assert.deepEqual(afterReview.review.revision, REVISION);
  assert.equal(afterReview.pr, null);

  const merging = fakeContext({
    stage: "merge",
    state: afterReview,
    ops: {
      "current-revision": [currentFor, currentFor],
      "wiki-sync": [WIKI_UNCHANGED],
      "wiki-check": [{ pass: true, checks: [] }],
      publish: [PUBLISHED],
      "finish-wiki": [FINISHED],
    },
  });
  const done = stateOf(await mergeRole(merging.ctx), "next");
  const ran = opNames(merging.calls);
  for (const name of CODE_MERGE_OPS) {
    assert.ok(!ran.includes(name), `ran ${name}`);
  }
  assert.ok(ran.indexOf("publish") < ran.indexOf("finish-wiki"));
  assert.equal(done.stage, "done");
  assert.equal(done.pr, null);
  assert.equal(done.codeMerged, null);
  assert.deepEqual(done.merged, { ...REVISION, code: null });
  const { state: finished } = firstPayload(merging.calls, "finish-wiki");
  assert.deepEqual(finished, done);
});

test("a branch that changes code, code and wiki, or nothing keeps its PR and closes nothing", async () => {
  const changes = [
    { codeChanged: true, wikiAhead: 0 },
    { codeChanged: true, wikiAhead: 1 },
    { codeChanged: false, wikiAhead: 0 },
  ];
  const runs = await Promise.all(changes.map((change) => implemented(change)));
  for (const { end, calls } of runs) {
    assert.ok(!opNames(calls).includes("close-pr"));
    assert.equal(stateOf(end, "next").pr, PR);
  }
});

test("a failed close of the draft fails the role, which saves no state without the PR", async () => {
  const failure = new Error("gh: network");
  const { ctx, calls } = fakeContext({
    stage: "implement",
    state: issueState({ stage: "implement", pr: null, flows: null }),
    ops: {
      ...IMPLEMENT_OPS,
      "close-pr": [() => Promise.reject(failure)],
    },
    sessions: [{ ok: true, reply: { outcome: "done", summary: "Docs" } }],
  });
  await assert.rejects(implementorRole(ctx), failure);
  assert.equal(opNames(calls).at(-1), "close-pr");
  assert.deepEqual(savesOf(calls), []);
});
