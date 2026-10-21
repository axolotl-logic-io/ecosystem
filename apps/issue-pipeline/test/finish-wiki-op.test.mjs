// @ts-check
// The finish-wiki op (src/ops/finish.ts): completes an issue only from its
// saved done+merged state, after fresh proof that the PR merged at
// merged.code and the trusted inputs are unchanged, and with a saved security
// review that found nothing at exactly that merged revision; it merges
// nothing, and is safe to repeat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commentWriteReplies, labelReplies } from "./gh-mutation-fixtures.mjs";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  PR,
  REPO,
  savedListing,
  securityOf,
  sh,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { finishWiki } = await import("../src/ops/finish.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
// What the finish-wiki op's writes, refusals and closing comment say.
const DELETES_ISSUE_BRANCH =
  /DELETE repos\/o\/r\/git\/refs\/heads\/agent\/issue-7/u;
const CLOSES_COMPLETED = /^issue close 7 -R o\/r --reason completed --comment/u;

const NAMES_WIKI_COMMIT = /Published wiki commit/u;
const NOT_SAVED_DONE = /saved state done/u;
const NOT_SAVED_COMPLETION = /not the saved completion/u;
const NOT_THE_MERGE_COMMIT = /not PR #50's merge commit/u;
const ISSUE = 7;
const CLAIM_ID = 501;
const SHORT_SHA_LENGTH = 12;

// #7 saved done, merged as w.mergeSha, the security review of that merged
// result clear.
/** @param {World} w @param {object} [extra] @returns {import("../src/state.ts").IssueState} */
function doneState(w, extra = {}) {
  const approved = { code: w.sha, wiki: null, inputs: "inputs-1" };
  const merged = { code: w.mergeSha, wiki: null, inputs: "inputs-1" };
  return {
    ...approvedState(approved),
    stage: "done",
    lease: null,
    merged,
    verifiedSha: w.mergeSha,
    security: securityOf(merged),
    ...extra,
  };
}

/** @param {World} w @param {string} [inputs] @returns {void} */
function mergedPr(w, inputs = "inputs-1") {
  sh(
    `git --git-dir=${w.root}/origin.git update-ref refs/heads/integration ${w.mergeSha}`,
  );
  setCurrentRevision({
    revision: { code: w.mergeSha, wiki: null, inputs },
    baseSha: "base",
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: w.mergeSha,
      headSha: w.sha,
    },
  });
}

/** @param {string} open @param {number | null} [pr] @returns {import("./fake-gh.mjs").GhReply[]} */
function issueIs(open, pr = PR) {
  const targets = [ISSUE];
  if (pr !== null) {
    targets.push(pr);
  }
  return [
    {
      when: `repos/${REPO}/issues/7 --jq {state}`,
      stdout: JSON.stringify({ state: open }),
    },
    {
      when: "api -X DELETE repos/o/r/git/refs/heads/agent/issue-7 --silent",
      stdout: "",
    },
    ...targets.flatMap((target) =>
      labelReplies(REPO, target, ["agent:merged"], ["agent:working"]),
    ),
    ...commentWriteReplies(REPO, ISSUE, [CLAIM_ID]),
    { when: "issue close 7 -R o/r --reason completed --comment", stdout: "" },
  ];
}

/** @param {string[][]} done @returns {string[]} */
function flat(done) {
  return done.map((args) => args.join(" "));
}

test("finish-wiki completes a saved done+merged issue: branch, labels, claim, then the close", () => {
  const w = world();
  mergedPr(w);
  const saved = doneState(w);
  fakeGh.reply([savedListing(saved, { claim: true }), ...issueIs("open")]);
  assert.deepEqual(finishWiki(w.cfg, { number: 7, state: saved }), {
    finished: true,
    closed: true,
  });
  const done = flat(writes());
  assert.match(done[0] ?? "", DELETES_ISSUE_BRANCH);
  const identities = fakeGh.authenticatedCalls();
  const deletion = identities.find((call) =>
    DELETES_ISSUE_BRANCH.test(call.args.join(" ")),
  );
  assert.equal(deletion?.identity, "dev");
  assert.ok(done.some((line) => line.includes("issues/50/labels")));
  assert.ok(done.some((line) => line.includes("issues/7/labels")));
  assert.ok(done.some((line) => line.includes("issues/comments/501")));
  const close = done.at(-1) ?? "";
  assert.match(close, CLOSES_COMPLETED);
  assert.ok(
    close.includes(
      `PR #50 merged into integration as ${w.mergeSha.slice(0, SHORT_SHA_LENGTH)}.`,
    ),
  );
  assert.doesNotMatch(close, NAMES_WIKI_COMMIT);
  assert.equal(
    done.some((line) => line.includes("agent-pipeline:state")),
    false,
  );
});

test("finish-wiki again after the close closes nothing twice", () => {
  const w = world();
  mergedPr(w);
  const saved = doneState(w);
  fakeGh.reply([savedListing(saved), ...issueIs("closed")]);
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
  const w = world();
  mergedPr(w);
  const saved = doneState(w);
  fakeGh.reply([
    savedListing(saved),
    {
      when: "git/refs/heads/agent/issue-7",
      code: 1,
      stderr: "Reference does not exist",
    },
    ...issueIs("open"),
  ]);
  assert.equal(finishWiki(w.cfg, { number: 7 }).finished, true);
});

test("finish-wiki refuses new trusted input and changes nothing", () => {
  const w = world();
  mergedPr(w, "inputs-2");
  fakeGh.reply([savedListing(doneState(w))]);
  const reply = finishWiki(w.cfg, { number: 7 });
  assert.equal(reply.finished, false);
  assert.equal("reason" in reply && reply.reason, "inputs-changed");
  assert.deepEqual(writes(), []);
});

test("finish-wiki fails on a saved state that isn't a completion, or a request that isn't the saved one", () => {
  const w = world();
  mergedPr(w);
  fakeGh.reply([savedListing(doneState(w, { stage: "merge" }))]);
  assert.throws(() => finishWiki(w.cfg, { number: 7 }), NOT_SAVED_DONE);
  fakeGh.reply([savedListing(doneState(w))]);
  const other = doneState(w, {
    merged: { code: "0ther", wiki: null, inputs: "x" },
  });
  assert.throws(
    () => finishWiki(w.cfg, { number: 7, state: other }),
    NOT_SAVED_COMPLETION,
  );
  assert.deepEqual(writes(), []);
});

test("finish-wiki fails when the saved merge commit isn't the PR's", () => {
  const w = world();
  mergedPr(w);
  const saved = doneState(w, {
    merged: { code: "0ther", wiki: null, inputs: "inputs-1" },
  });
  fakeGh.reply([savedListing(saved)]);
  assert.throws(() => finishWiki(w.cfg, { number: 7 }), NOT_THE_MERGE_COMMIT);
  assert.deepEqual(writes(), []);
});
