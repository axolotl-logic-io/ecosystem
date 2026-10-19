// @ts-check
// The authoritative PR read checks its actual target, independently of head.
import assert from "node:assert/strict";
import { test } from "node:test";
import { collaboratorReply } from "./gh-mutation-fixtures.mjs";
import { issueReply } from "./ops-claim-test-kit.mjs";
import {
  CONFIG,
  commentsReply,
  reply,
  requireGhReplies,
  writes,
} from "./ops-cli-test-kit.mjs";

requireGhReplies();
const { loadConfig } = await import("../src/config.ts");
const { currentRevision, pullRequest } = await import("../src/revision.ts");
const cfg = loadConfig(CONFIG);
const NUMBER = 700;
const PR = 701;
const SHA_LENGTH = 40;
const HEAD = "a".repeat(SHA_LENGTH);
const MERGED = "b".repeat(SHA_LENGTH);
const TARGET_REFUSAL = /targets .+, not integration/u;

/** @param {string} state @param {string} baseRefName @returns {import("./fake-gh.mjs").GhReply} */
function prView(state, baseRefName) {
  let mergeCommit = null;
  if (state === "MERGED") {
    mergeCommit = { oid: MERGED };
  }
  return {
    when: `pr view ${PR}`,
    stdout: JSON.stringify({
      number: PR,
      state,
      mergeCommit,
      headRefName: `agent/issue-${NUMBER}`,
      headRefOid: HEAD,
      baseRefName,
      isCrossRepository: false,
    }),
  };
}

for (const state of ["OPEN", "MERGED"]) {
  for (const baseRefName of ["main", "other"]) {
    test(`current revision refuses ${state} exact-head PR targeting ${baseRefName} before Git reads`, () => {
      reply([
        collaboratorReply("o/r", "alice"),
        commentsReply(NUMBER, []),
        issueReply(NUMBER),
        prView(state, baseRefName),
      ]);
      assert.throws(
        () => currentRevision(cfg, NUMBER, { pr: PR }),
        TARGET_REFUSAL,
      );
      assert.deepEqual(writes(), []);
    });
  }
  test(`authoritative ${state} PR on configured base is accepted`, () => {
    reply([prView(state, cfg.baseBranch)]);
    const found = pullRequest(cfg, NUMBER, PR);
    assert.equal(found.headSha, HEAD);
    assert.equal(found.state, state);
    assert.deepEqual(writes(), []);
  });
}
