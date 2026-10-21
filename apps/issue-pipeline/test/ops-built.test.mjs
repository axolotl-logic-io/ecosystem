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
import { approvalReply, branchMergeReply } from "./merge-op-fixtures.mjs";
import { mergeWorld } from "./ops-built-merge-fixtures.mjs";
import { releaseReplies } from "./ops-release-test-kit.mjs";
import {
  ask,
  calls,
  claimListing,
  fakeGh,
  LANE,
  SWEEP,
  stateListing,
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
const BRANCH_MERGE =
  "api repos/o/r/merges --method POST --include -f base=integration -f head=<sha>";
const BEFORE_MERGE_VIEWS = 3;
// The part of current-revision's reply the merge request carries.
const CURRENT = z.looseObject({
  revision: z.object({
    code: z.string(),
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
    user: { login: "alice" },
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

// The same PR retains original H after merging at actual M.
/** @param {string} sha @param {string} mergeSha @returns {import("./fake-gh.mjs").GhReply[]} */
function prViews(sha, mergeSha) {
  const pr = {
    url: "https://github.com/o/r/pull/50",
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
  const merged = { ...pr, state: "MERGED", mergeCommit: { oid: mergeSha } };
  return [
    ...Array.from({ length: BEFORE_MERGE_VIEWS }, () => ({
      when: "pr view 50 -R o/r --json",
      stdout: JSON.stringify(open),
    })),
    {
      when: "pr view 50 -R o/r --json",
      stdout: JSON.stringify(merged),
      keep: true,
    },
  ];
}

// Merges #7 in `w` at its current revision and releases it, through `ops`
// (src/ops.ts when undefined): the replies and gh calls, with the world's
// head and paths made constant.
/** @param {World} initial @param {string | undefined} ops */
function mergeAndRelease(initial, ops) {
  const w = mergeWorld(initial);
  /** @param {string} text @returns {string} */
  function constant(text) {
    return text
      .replaceAll(w.mergeSha, "<merge-sha>")
      .replaceAll(w.mergeSha.slice(0, SHORT_SHA), "<merge-sha>")
      .replaceAll(w.sha, "<sha>")
      .replaceAll(w.sha.slice(0, SHORT_SHA), "<sha>")
      .replaceAll(w.root, "<root>");
  }
  const lease = { lane: LANE, sweepId: SWEEP, at: "2026-01-01T00:00:00Z" };
  const state = issueState({ stage: "merge", pr: PR, lease });
  fakeGh.reply([
    collaboratorReply("o/r", "alice"),
    issueListing(),
    { ...claimListing(), keep: true },
    ...prViews(w.sha, w.mergeSha),
  ]);
  const asked = ask(w, { op: "current-revision", number: ISSUE, state }, ops);
  const current = CURRENT.parse(JSON.parse(asked));
  fakeGh.reply([
    collaboratorReply("o/r", "alice"),
    issueListing(),
    {
      ...stateListing(ISSUE, { ...state, hardened: current.revision }),
      keep: true,
      persistState: true,
    },
    { when: "api -X PATCH repos/o/r/issues/comments/7 -f", keep: true },
    ...prViews(w.sha, w.mergeSha),
    approvalReply(w),
    branchMergeReply(w),
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
    releaseReplies({ ...state, codeMerged: { pr: PR, sha: w.mergeSha } }),
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
  assert.ok(
    fromSrc.mergeCalls.includes(BRANCH_MERGE),
    "it named the exact target and source",
  );
  const fromBuild = mergeAndRelease(world(), path.join(out, "ops.mjs"));
  assert.deepEqual(fromBuild, fromSrc);
});
