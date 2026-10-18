// @ts-check
// The built ops CLI against src/ops.ts: each reads the current revision,
// merges at it and releases the issue, with the same replies and gh calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import {
  collaboratorReply,
  commentWriteReplies,
} from "./gh-mutation-fixtures.mjs";
import { releaseReplies } from "./ops-release-test-kit.mjs";
import {
  ask,
  calls,
  claimListing,
  fakeGh,
  hoursFromNow,
  LANE,
  SWEEP,
  world,
} from "./ops-test-kit.mjs";

/** @import { World } from "./ops-test-kit.mjs" */

fakeGh.requireReplies();
const { newIssueState } = await import("../src/state.ts");

// The issue every test works on, and its PR.
const ISSUE = 7;
const PR = 50;
// The commit prefix the merger comment names.
const SHORT_SHA = 12;
const MERGED_TRUE = /"merged":true/u;
const SQUASH_MERGE = "pr merge 50 -R o/r --squash --match-head-commit <sha>";
const SHA_LENGTH = 40;
const MERGE_OID = "c".repeat(SHA_LENGTH);
// The part of current-revision's reply the merge request carries.
const CURRENT = z.looseObject({
  revision: z.object({
    code: z.string(),
    wiki: z.string().nullable(),
    inputs: z.string(),
  }),
});

// gh's reply to getIssue for #7: open, by the account, with no labels.
/** @returns {import("./fake-gh.mjs").GhReply} */
function issueListing() {
  const issue = {
    number: ISSUE,
    title: "Issue 7",
    body: "",
    state: "open",
    user: { login: "bot" },
    labels: [],
  };
  return {
    when: `api repos/o/r/issues/${ISSUE}`,
    stdout: JSON.stringify(issue),
    keep: true,
  };
}

// Issue #7's version 2 state with `extra` over a new issue's.
/** @param {object} extra @returns {Record<string, unknown>} */
function issueState(extra) {
  return { ...newIssueState(ISSUE), ...extra };
}

// gh's replies to the PR views, open at `sha` until the merge and merged at
// `sha` after it: the revision's view, then the merge op's.
/** @param {string} sha @returns {import("./fake-gh.mjs").GhReply[]} */
function prViews(sha) {
  const pr = {
    number: PR,
    headRefName: `agent/issue-${ISSUE}`,
    headRefOid: sha,
    baseRefName: "integration",
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
  };
  const open = { ...pr, state: "OPEN" };
  const merged = { ...pr, state: "MERGED", mergeCommit: { oid: MERGE_OID } };
  return [
    { when: "--json number", stdout: JSON.stringify(open), keep: true },
    { when: "--json baseRefName", stdout: JSON.stringify(open) },
    { when: "--json baseRefName", stdout: JSON.stringify(open) },
    { when: "--json baseRefName", stdout: JSON.stringify(merged) },
  ];
}

// Merges #7 in `w` at its current revision and releases it, through `ops`
// (src/ops.ts when undefined): the replies and gh calls, with the world's
// head and paths made constant.
/** @param {World} w @param {string | undefined} ops */
function mergeAndRelease(w, ops) {
  /** @param {string} text @returns {string} */
  function constant(text) {
    return text
      .replaceAll(w.sha, "<sha>")
      .replaceAll(w.sha.slice(0, SHORT_SHA), "<sha>")
      .replaceAll(w.root, "<root>");
  }
  const lease = { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) };
  const state = issueState({ stage: "merge", pr: PR, lease });
  fakeGh.reply([
    collaboratorReply("o/r", "bot"),
    issueListing(),
    { ...claimListing(), keep: true },
    ...prViews(w.sha),
    {
      when: `pr merge ${PR} -R o/r --squash --match-head-commit ${w.sha}`,
      stdout: "",
    },
    ...commentWriteReplies("o/r", PR, []),
  ]);
  const asked = ask(w, { op: "current-revision", number: ISSUE, state }, ops);
  const current = CURRENT.parse(JSON.parse(asked));
  fakeGh.reply([
    collaboratorReply("o/r", "bot"),
    issueListing(),
    { ...claimListing(), keep: true },
    ...prViews(w.sha),
    {
      when: `pr merge ${PR} -R o/r --squash --match-head-commit ${w.sha}`,
      stdout: "",
    },
    ...commentWriteReplies("o/r", PR, []),
  ]);
  // The merge op merges only the revision hardening authorized.
  const req = {
    op: "merge",
    number: ISSUE,
    state: { ...state, hardened: current.revision },
    expectedSha: w.sha,
    revision: current.revision,
    mergeQueue: null,
  };
  const merged = constant(ask(w, req, ops));
  const mergeCalls = calls().map((args) => constant(args.join(" ")));
  fakeGh.reply(
    releaseReplies({ ...state, codeMerged: { pr: PR, sha: MERGE_OID } }),
  );
  const release_ = { op: "release", number: ISSUE, lane: LANE, sweepId: SWEEP };
  const released = ask(
    w,
    { ...release_, state: { ...state, lease: null } },
    ops,
  );
  const releaseCalls = calls().map((args) => constant(args.join(" ")));
  return { merged, mergeCalls, released, releaseCalls };
}

test("the built ops merges and releases as src/ops.ts does", () => {
  const out = fs.mkdtempSync("/tmp/issue-pipeline-built-ops-");
  process.on("exit", () => fs.rmSync(out, { recursive: true, force: true }));
  const build = new URL("../build.ts", import.meta.url).pathname;
  const built = spawnSync(process.execPath, [build, out], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const fromSrc = mergeAndRelease(world(), undefined);
  assert.match(fromSrc.merged, MERGED_TRUE);
  assert.equal(
    z.looseObject({ ok: z.literal(true) }).parse(JSON.parse(fromSrc.released))
      .ok,
    true,
  );
  assert.ok(fromSrc.mergeCalls.includes(SQUASH_MERGE), "it squash-merged");
  const fromBuild = mergeAndRelease(world(), path.join(out, "ops.mjs"));
  assert.deepEqual(fromBuild, fromSrc);
});
