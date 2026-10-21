// @ts-check
// The security review's hold on completion (src/security-clearance.ts, via
// the finish op): after a merge into the base, the issue doesn't
// complete unless the issue's saved state holds a security review that found
// nothing at exactly the merged result: GitHub's merge commit and the trusted
// inputs. A missing review, a finding, or a review of any other revision (the
// pre-merge head included) refuses as `security`, changing nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./fake-ops-publish-revision.mjs";
import {
  approvedState,
  fakeGh,
  MERGE_COMMIT,
  PR,
  savedListing,
  securityOf,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { finishIssue } = await import("../../src/ops/finish.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
/** @typedef {import("../../src/state.ts").Revision} Revision */
/** @typedef {import("../../src/state.ts").Security} Security */

const DONE_WITH_CODE_BUT_NO_PR = /done with code .* but no PR/u;
const NOT_THE_AUTHORIZED_HEAD =
  /merge authorization .* is not .*, which PR #50 merged/u;
/** @type {NonNullable<Security["finding"]>} */
const FINDING = { category: "user-harm", reason: "leaks the users' tokens" };

/** @param {World} w @returns {{ approved: Revision, result: Revision }} */
function chainOf(w) {
  return {
    approved: { code: w.sha, inputs: "inputs-1" },
    result: { code: MERGE_COMMIT, inputs: "inputs-1" },
  };
}

// GitHub says PR #50 merged head w.sha as MERGE_COMMIT; inputs unchanged.
/** @param {World} w @returns {void} */
function merged(w) {
  setCurrentRevision({
    revision: { code: MERGE_COMMIT, inputs: "inputs-1" },
    baseSha: "base",
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: MERGE_COMMIT,
      headSha: w.sha,
    },
  });
}

// Security reviews that don't clear `result`: none, one with a finding, and
// ones of another code head or trusted inputs.
/** @param {World} w @param {Revision} result @returns {(Security | null)[]} */
function unclearing(w, result) {
  return [
    null,
    securityOf(result, FINDING),
    securityOf({ ...result, code: w.sha }),
    securityOf({ ...result, inputs: "inputs-0" }),
  ];
}

test("finish refuses a saved completion its security review doesn't clear, changing nothing", () => {
  const w = world();
  const { approved, result } = chainOf(w);
  merged(w);
  for (const security of unclearing(w, result)) {
    const saved = {
      ...approvedState(approved),
      stage: "done",
      merged: result,
      security,
    };
    fakeGh.reply([savedListing(saved)]);
    const reply = finishIssue(w.cfg, { number: 7, state: saved });
    assert.equal("reason" in reply && reply.reason, "security");
    assert.deepEqual(writes(), []);
  }
});

test("finish fails on a change with no PR saved as merging code", () => {
  const w = world();
  const { approved } = chainOf(w);
  setCurrentRevision({ revision: approved, baseSha: "base", pr: null });
  const saved = {
    ...approvedState(approved),
    stage: "done",
    pr: null,
    flows: { code: true },
    merged: approved,
    security: securityOf(approved),
  };
  fakeGh.reply([savedListing(saved)]);
  assert.throws(
    () => finishIssue(w.cfg, { number: 7 }),
    DONE_WITH_CODE_BUT_NO_PR,
  );
  assert.deepEqual(writes(), []);
});

test("finish fails on a completion whose merge authorization isn't the head GitHub merged, changing nothing", () => {
  const w = world();
  const { approved, result } = chainOf(w);
  merged(w);
  for (const hardened of [null, { ...approved, code: "0ther" }]) {
    const saved = {
      ...approvedState(approved, { hardened }),
      stage: "done",
      merged: result,
      security: securityOf(result),
    };
    fakeGh.reply([savedListing(saved)]);
    assert.throws(
      () => finishIssue(w.cfg, { number: 7 }),
      NOT_THE_AUTHORIZED_HEAD,
    );
    assert.deepEqual(writes(), []);
  }
});
