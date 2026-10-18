// @ts-check
// A change that lives only in the wiki, across the roles: the Developer's
// own end state, as the next claims hand it on, goes through the Reviewer's
// hardening and the merge, whose security review of the result clears it,
// to a publish and finish, with no code merge. The Developer closes its
// draft PR, so no PR is the issue's any more; the
// fake current-revision answers as the real op reads the PR (revision.ts
// issuePullRequest): the state's PR by number, else validated all-state
// history permits only genuine unchanged wiki work to omit the closed draft. The claim keeps the same
// PR the same way, so each role's end state is the next role's state.
// reviewer-and-merge-role-kit sets a temporary HOME and root before any
// pipeline module loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FINISHED,
  NO_FINDING,
  PREPARED_MERGED,
} from "./merge-role-test-kit.mjs";
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
import {
  HARDENED,
  PUSHED,
  VERIFIED,
  WIKI_PASS,
} from "./reviewer-role-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);

const WIKI_PAGE = "wiki/Chats.md";
// The Developer's ops for a branch whose only commits are the wiki's: the
// draft and its push, with no sync and no verification.
const IMPLEMENT_OPS = {
  "start-pr": [{ pr: PR, headSha: HEAD }],
  "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: false, wikiAhead: 1 }],
  "close-pr": [{ pr: PR, closed: true }],
};
// The security review's bundle of a change that merged no code.
const PREPARED = {
  ...PREPARED_MERGED,
  headSha: HEAD,
  changedFiles: [WIKI_PAGE],
};
const WIKI_UNCHANGED = { conflict: false, changed: false, headSha: WIKI };
const PUBLISHED = { published: true, sha: WIKI, commits: [] };
// The ops that merge code or ready a PR, which a wiki-only change never runs.
const CODE_MERGE_OPS = ["merge", "ci-status", "sync-base", "ready-pr"];

/**
 * current-revision as the real op answers it for the state it is given:
 * the saved PR, now closed, or no PR when the state names none.
 * @param {{ state: import("../src/state.ts").IssueState }} payload
 */
function currentFor({ state }) {
  if (state.pr === null) {
    return current({}, null);
  }
  return current(
    {},
    {
      number: state.pr,
      state: "CLOSED",
      mergeCommit: null,
      headSha: HEAD,
    },
  );
}

/**
 * The Developer's end, and the calls it made, for a branch that open-pr
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

/**
 * The Reviewer's hardening of `state`, a wiki-only change with no PR: its
 * end and the calls it made.
 * @param {import("../src/state.ts").IssueState} state
 */
async function hardenedFrom(state) {
  const { ctx, calls } = fakeContext({
    stage: "review",
    state,
    ops: {
      "current-revision": [currentFor, currentFor],
      verify: [VERIFIED],
      "wiki-check": [WIKI_PASS],
      push: [{ ...PUSHED, codeChanged: false }],
    },
    sessions: [HARDENED],
  });
  return { end: await reviewerRole(ctx), calls };
}

test("the Developer's wiki-only end names no PR, so hardening, merge and its security review publish it with no code merge", async () => {
  const implementing = await implemented();
  assert.deepEqual(opNames(implementing.calls), [
    "start-pr",
    "open-pr",
    "close-pr",
  ]);
  const afterImplement = stateOf(implementing.end, "next");
  assert.equal(afterImplement.stage, "review");
  assert.equal(afterImplement.pr, null);
  assert.deepEqual(afterImplement.flows, { code: false, wiki: true });

  const reviewing = await hardenedFrom(afterImplement);
  const afterReview = stateOf(reviewing.end, "next");
  assert.equal(postsOf(reviewing.calls)[0]?.on, "issue");
  const { wikiOnly } = firstPayload(reviewing.calls, "push");
  assert.equal(wikiOnly, true);
  assert.equal(afterReview.stage, "merge");
  assert.deepEqual(afterReview.hardened, REVISION);
  assert.equal(afterReview.pr, null);

  const merging = fakeContext({
    stage: "merge",
    state: afterReview,
    ops: {
      "current-revision": [currentFor, currentFor, currentFor],
      "wiki-sync": [WIKI_UNCHANGED],
      "wiki-check": [WIKI_PASS],
      "prepare-review": [PREPARED],
      publish: [PUBLISHED],
      "finish-wiki": [FINISHED],
    },
    sessions: [NO_FINDING],
  });
  const done = stateOf(await mergeRole(merging.ctx), "next");
  const ran = opNames([...reviewing.calls, ...merging.calls]);
  for (const name of CODE_MERGE_OPS) {
    assert.ok(!ran.includes(name), `ran ${name}`);
  }
  const merged = opNames(merging.calls);
  assert.ok(merged.indexOf("prepare-review") < merged.indexOf("publish"));
  assert.ok(merged.indexOf("publish") < merged.indexOf("finish-wiki"));
  const { codeMerged } = firstPayload(merging.calls, "prepare-review");
  assert.equal(codeMerged, null);
  assert.equal(done.stage, "done");
  assert.equal(done.pr, null);
  assert.equal(done.codeMerged, null);
  assert.deepEqual(done.merged, { ...REVISION, code: null });
  assert.deepEqual(done.security?.revision, { ...REVISION, code: null });
  assert.equal(done.security?.finding, null);
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
  assert.deepEqual(savesOf(calls), [
    issueState({ stage: "implement", pr: PR, flows: null }),
  ]);
});
