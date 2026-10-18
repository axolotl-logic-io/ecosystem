// @ts-check
// The finish-wiki op (src/ops/finish.ts): completes an issue only from its
// saved done+merged state, after fresh proof that the PR merged at
// merged.code, the wiki holds merged.wiki and the trusted inputs are
// unchanged; it publishes and merges nothing, and is safe to repeat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  MERGE_COMMIT,
  PR,
  REPO,
  savedListing,
  wikiRef,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { finishWiki } = await import("../src/ops/finish.ts");
const { publishOps } = await import("../src/ops/publish.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */

/** @param {World} w @param {object} [extra] @returns {import("../src/state.ts").IssueState} */
function doneState(w, extra = {}) {
  const approved = { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" };
  return {
    ...approvedState(approved),
    stage: "done",
    lease: null,
    merged: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
    ...extra,
  };
}

/** @param {World} w @param {string} [inputs] @returns {void} */
function mergedPr(w, inputs = "inputs-1") {
  setCurrentRevision({
    revision: { code: MERGE_COMMIT, wiki: null, inputs },
    baseSha: "base",
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: MERGE_COMMIT,
      headSha: w.sha,
    },
  });
}

// Publishes #7's approved wiki head as the merge role does before saving.
/** @param {World} w @returns {void} */
function published(w) {
  const approved = { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" };
  setCurrentRevision({
    revision: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
    baseSha: "base",
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: MERGE_COMMIT,
      headSha: w.sha,
    },
  });
  fakeGh.reply([]);
  const reply = publishOps["publish"]?.(w.cfg, {
    number: 7,
    state: approvedState(approved),
    expectedWiki: w.wikiSha,
    revision: approved,
  });
  assert.equal(reply?.published, true);
}

/** @param {string} open @returns {import("./fake-gh.mjs").GhReply} */
function issueIs(open) {
  return {
    when: `repos/${REPO}/issues/7 --jq {state}`,
    stdout: `{"state":"${open}"}`,
  };
}

/** @param {string[][]} done @returns {string[]} */
function flat(done) {
  return done.map((args) => args.join(" "));
}

test("finish-wiki completes a saved done+merged issue: branch, labels, claim, then the close", () => {
  const w = world({ wiki: true });
  published(w);
  mergedPr(w);
  const saved = doneState(w);
  fakeGh.reply([savedListing(saved, { claim: true }), issueIs("open")]);
  assert.deepEqual(finishWiki(w.cfg, { number: 7, state: saved }), {
    finished: true,
    closed: true,
  });
  const done = flat(writes());
  assert.match(
    done[0] ?? "",
    /DELETE repos\/o\/r\/git\/refs\/heads\/agent\/issue-7/u,
  );
  assert.ok(done.some((line) => line.includes("issues/50/labels")));
  assert.ok(done.some((line) => line.includes("issues/7/labels")));
  assert.ok(done.some((line) => line.includes("issues/comments/501")));
  const close = done.at(-1) ?? "";
  assert.match(close, /^issue close 7 -R o\/r --reason completed --comment/u);
  assert.match(close, /PR #50 merged into integration as 4e1d0c0ffee0\./u);
  assert.match(close, /Published wiki commit/u);
  assert.equal(
    done.some((line) => line.includes("agent-pipeline:state")),
    false,
  );
});

test("finish-wiki again after the close closes nothing twice", () => {
  const w = world({ wiki: true });
  published(w);
  mergedPr(w);
  const saved = doneState(w);
  fakeGh.reply([savedListing(saved), issueIs("closed")]);
  assert.deepEqual(finishWiki(w.cfg, { number: 7 }), {
    finished: true,
    closed: false,
  });
  assert.equal(
    flat(writes()).some((line) => line.startsWith("issue close")),
    false,
  );
});

test("finish-wiki completes after the code branch was already deleted", () => {
  const w = world({ wiki: true });
  published(w);
  mergedPr(w);
  const saved = doneState(w);
  fakeGh.reply([
    savedListing(saved),
    {
      when: "git/refs/heads/agent/issue-7",
      code: 1,
      stderr: "Reference does not exist",
    },
    issueIs("open"),
  ]);
  assert.equal(finishWiki(w.cfg, { number: 7 }).finished, true);
});

test("finish-wiki refuses new trusted input and changes nothing", () => {
  const w = world({ wiki: true });
  published(w);
  mergedPr(w, "inputs-2");
  fakeGh.reply([savedListing(doneState(w))]);
  const reply = finishWiki(w.cfg, { number: 7 });
  assert.equal(reply.finished, false);
  assert.equal("reason" in reply && reply.reason, "inputs-changed");
  assert.deepEqual(writes(), []);
});

test("finish-wiki refuses a wiki commit the wiki doesn't hold, and changes nothing", () => {
  const w = world({ wiki: true });
  mergedPr(w);
  fakeGh.reply([savedListing(doneState(w))]);
  const reply = finishWiki(w.cfg, { number: 7 });
  assert.equal("reason" in reply && reply.reason, "wiki-unpublished");
  assert.deepEqual(writes(), []);
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

test("finish-wiki fails on a saved state that isn't a completion, or a request that isn't the saved one", () => {
  const w = world({ wiki: true });
  mergedPr(w);
  fakeGh.reply([savedListing(doneState(w, { stage: "merge" }))]);
  assert.throws(() => finishWiki(w.cfg, { number: 7 }), /saved state done/u);
  fakeGh.reply([savedListing(doneState(w))]);
  const other = doneState(w, {
    merged: { code: "0ther", wiki: null, inputs: "x" },
  });
  assert.throws(
    () => finishWiki(w.cfg, { number: 7, state: other }),
    /not the saved completion/u,
  );
  assert.deepEqual(writes(), []);
});

test("finish-wiki fails when the saved merge commit isn't the PR's", () => {
  const w = world({ wiki: true });
  published(w);
  mergedPr(w);
  const saved = doneState(w, {
    merged: { code: "0ther", wiki: w.wikiSha, inputs: "inputs-1" },
  });
  fakeGh.reply([savedListing(saved)]);
  assert.throws(
    () => finishWiki(w.cfg, { number: 7 }),
    /not PR #50's merge commit/u,
  );
  assert.deepEqual(writes(), []);
});

test("finish-wiki completes a change that lives only in the wiki, with no PR", () => {
  const w = world({ wiki: true });
  const approved = { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" };
  setCurrentRevision({ revision: approved, baseSha: "base", pr: null });
  const state = {
    ...approvedState(approved),
    pr: null,
    flows: { code: false, wiki: true },
  };
  fakeGh.reply([]);
  const reply = publishOps["publish"]?.(w.cfg, {
    number: 7,
    state,
    expectedWiki: w.wikiSha,
    revision: approved,
  });
  assert.equal(reply?.published, true);
  const saved = { ...state, stage: "done", merged: approved };
  fakeGh.reply([savedListing(saved), issueIs("open")]);
  assert.deepEqual(finishWiki(w.cfg, { number: 7 }), {
    finished: true,
    closed: true,
  });
  const done = flat(writes());
  assert.equal(
    done.some((line) => line.includes("issues/50/")),
    false,
  );
  assert.match(done.at(-1) ?? "", /lives only in the wiki/u);
});

test("finish-wiki completes a merged PR with no wiki change, with no wiki to prove", () => {
  const w = world();
  mergedPr(w);
  const saved = doneState(w);
  fakeGh.reply([savedListing(saved), issueIs("open")]);
  assert.deepEqual(finishWiki(w.cfg, { number: 7 }), {
    finished: true,
    closed: true,
  });
});
