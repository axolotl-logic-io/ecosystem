// @ts-check
// Publish-only integration keeps the retained issue head separate from the
// verified merge commit, then resumes its exact receipt through security
// and wiki publication without any code mutation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFTER_MERGE,
  CODE_MERGED,
  FINISHED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  NO_FINDING,
  PREPARED_MERGED,
  WIKI_PASS,
} from "./merge-role-test-kit.mjs";
import {
  checksBefore,
  endCode,
  firstPayload,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  current,
  fakeContext,
  HEAD,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
} from "./reviewer-and-merge-role-kit.mjs";

const WIKI_INTEGRATED = { ...MERGED_REVISION, wiki: MOVED };
const AFTER_WIKI_INTEGRATION = current(WIKI_INTEGRATED, MERGED_PR);
const VERIFIED_MERGE = { pass: true, headSha: MERGE_COMMIT, checks: [] };

/** @param {Record<string, unknown[]>} [ops] */
function postmergeIntegration(ops = {}) {
  return merging({
    state: {
      ...CODE_MERGED,
      headSha: HEAD,
      verifiedSha: HEAD,
      hardened: MERGED_REVISION,
    },
    ops: {
      "current-revision": [AFTER_MERGE, AFTER_WIKI_INTEGRATION],
      "wiki-sync": [{ conflict: false, changed: true, headSha: MOVED }],
      verify: [VERIFIED_MERGE],
      "wiki-check": [WIKI_PASS],
      push: [{ headSha: HEAD, codeChanged: false, wikiAhead: 1 }],
      ...ops,
    },
    sessions: [],
  });
}

/** @param {import("../src/state.ts").IssueState} checkpoint */
function resumeIntegration(checkpoint) {
  return fakeContext({
    stage: "merge",
    state: checkpoint,
    ops: {
      "current-revision": [
        AFTER_WIKI_INTEGRATION,
        AFTER_WIKI_INTEGRATION,
        AFTER_WIKI_INTEGRATION,
      ],
      "wiki-sync": [{ conflict: false, changed: false, headSha: MOVED }],
      verify: [VERIFIED_MERGE],
      "wiki-check": [WIKI_PASS],
      "prepare-review": [PREPARED_MERGED],
      publish: [{ published: true, sha: MOVED, commits: ["Integrated wiki"] }],
      "finish-wiki": [FINISHED],
    },
    sessions: [NO_FINDING],
  });
}

async function integratedPostmerge() {
  const integration = postmergeIntegration();
  const checkpoint = stateOf(await mergeRole(integration.ctx), "wait");
  return { ...integration, checkpoint };
}

test("postmerge wiki integration accepts the retained head and preserves distinct checked provenance", async () => {
  assert.notEqual(HEAD, MERGE_COMMIT);
  const integration = await integratedPostmerge();
  const { checkpoint } = integration;
  assert.deepEqual(checkpoint.integration, {
    reviewed: MERGED_REVISION,
    revision: WIKI_INTEGRATED,
  });
  assert.deepEqual(checkpoint.hardened, MERGED_REVISION);
  assert.deepEqual(checkpoint.codeMerged, CODE_MERGED.codeMerged);
  assert.equal(checkpoint.headSha, HEAD);
  assert.equal(checkpoint.verifiedSha, MERGE_COMMIT);
  assert.deepEqual(firstPayload(integration.calls, "verify"), {
    number: integration.ctx.issue,
    ...CODE_MERGED,
  });
  assert.deepEqual(firstPayload(integration.calls, "push"), {
    number: integration.ctx.issue,
    wikiOnly: true,
  });
  assert.deepEqual(mutationsOf(integration.calls), ["wiki-sync", "push"]);
  assert.equal(sessionsOf(integration.calls).length, 0);
});

test("the postmerge wiki integration checkpoint resumes through read-only security and exact publication without code writes", async () => {
  // The caller saves integration's returned state before the next invocation.
  const { checkpoint } = await integratedPostmerge();
  // No code mutation is scripted: any push or merge on resume fails the test.
  // Clearance for the old wiki cannot authorize the integrated wiki.
  const resume = resumeIntegration({
    ...checkpoint,
    security: {
      revision: MERGED_REVISION,
      commentId: COMMENT_ID,
      finding: null,
    },
  });
  const done = stateOf(await mergeRole(resume.ctx), "next");
  assert.equal(done.stage, "done");
  assert.deepEqual(done.merged, WIKI_INTEGRATED);
  assert.deepEqual(done.hardened, checkpoint.hardened);
  assert.deepEqual(done.integration, checkpoint.integration);
  assert.deepEqual(done.codeMerged, checkpoint.codeMerged);
  assert.equal(done.headSha, HEAD);
  assert.equal(done.verifiedSha, MERGE_COMMIT);
  const [security] = sessionsOf(resume.calls);
  assert.equal(security?.phase, "security-review");
  assert.equal(security?.commits, false);
  assert.equal(sessionsOf(resume.calls).length, 1);
  assert.deepEqual(checksBefore(resume.calls, "prepare-review"), {
    verify: { number: resume.ctx.issue, ...CODE_MERGED },
    wiki: { number: resume.ctx.issue },
  });
  const { codeMerged } = firstPayload(resume.calls, "prepare-review");
  assert.deepEqual(codeMerged, CODE_MERGED.codeMerged);
  const { state, expectedWiki, revision } = firstPayload(
    resume.calls,
    "publish",
  );
  assert.equal(expectedWiki, MOVED);
  assert.deepEqual(revision, WIKI_INTEGRATED);
  assert.deepEqual(
    state,
    savesOf(resume.calls).find((saved) => saved.security !== null),
  );
  assert.deepEqual(done.security?.revision, WIKI_INTEGRATED);
  assert.equal(done.security?.finding, null);
  assert.ok(
    savesOf(resume.calls).some((saved) => saved.security === done.security),
  );
  assert.deepEqual(mutationsOf(resume.calls), [
    "wiki-sync",
    "publish",
    "finish-wiki",
  ]);
});

test("postmerge integration still refuses verification of the retained head instead of the merge commit", async () => {
  const { ctx, calls } = postmergeIntegration({
    verify: [{ ...VERIFIED_MERGE, headSha: HEAD }],
  });
  const end = await mergeRole(ctx);
  assert.equal(endCode(end), "error");
  assert.ok(end.kind === "stop");
  assert.ok(end.reason.includes(HEAD));
  assert.ok(end.reason.includes(MERGE_COMMIT));
  assert.equal(end.state.integration, null);
  assert.deepEqual(end.state.hardened, MERGED_REVISION);
  assert.deepEqual(end.state.codeMerged, CODE_MERGED.codeMerged);
  assert.deepEqual(mutationsOf(calls), ["wiki-sync"]);
  assert.equal(sessionsOf(calls).length, 0);
});

const MOVED_REVISIONS = [
  {
    name: "trusted inputs changed",
    revision: { ...WIKI_INTEGRATED, inputs: NEW_INPUTS },
    stage: "author",
  },
  {
    name: "merged code differs from verified code",
    revision: { ...WIKI_INTEGRATED, code: HEAD },
    stage: "review",
  },
];

for (const { name, revision, stage } of MOVED_REVISIONS) {
  test(`postmerge wiki push cannot authorize integration when ${name}`, async () => {
    const { ctx, calls } = postmergeIntegration({
      "current-revision": [AFTER_MERGE, current(revision, MERGED_PR)],
    });
    const state = stateOf(await mergeRole(ctx), "next");
    assert.equal(state.stage, stage);
    assert.equal(state.integration, null);
    assert.ok(savesOf(calls).every((saved) => saved.integration === null));
    assert.deepEqual(state.codeMerged, CODE_MERGED.codeMerged);
    assert.equal(state.headSha, HEAD);
    assert.deepEqual(firstPayload(calls, "push"), {
      number: ctx.issue,
      wikiOnly: true,
    });
    assert.deepEqual(mutationsOf(calls), ["wiki-sync", "push"]);
    assert.equal(sessionsOf(calls).length, 0);
  });
}
