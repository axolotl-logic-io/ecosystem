// The authoritative PR read checks its actual target, independently of head.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhReply } from "./fake-gh.ts";
import { collaboratorReply } from "./gh-mutation-fixtures.ts";
import { issueReply } from "./ops-claim-test-kit.ts";
import {
  CONFIG,
  commentsReply,
  reply,
  requireGhReplies,
  writes,
} from "./ops-cli-test-kit.ts";

requireGhReplies();
const { loadConfig }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { currentRevision, pullRequest }: typeof import("../src/revision.ts") =
  await import("../src/revision.ts");
const cfg = loadConfig(CONFIG);
const NUMBER = 700;
const PR = 701;
const SHA_LENGTH = 40;
const HEAD = "a".repeat(SHA_LENGTH);
const MERGED = "b".repeat(SHA_LENGTH);
const TARGET_REFUSAL = /targets .+, not integration/u;

function prView(state: string, baseRefName: string): GhReply {
  let mergeCommit: { oid: string } | null = null;
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
