// The merge and finish ops (src/ops/merge.ts, src/ops/merge-guard.ts,
// src/ops/finish-guard.ts) with the Reviewer's own integration: they merge and
// complete only the state's authorized revision (mergeAuthorization), which a
// receipt bound to the exact hardened revision moves to the integrated,
// checked one; a receipt bound to anything else authorizes nothing, and no
// review verdict authorizes a merge. The merge comment keeps the hardened head apart from
// the integrated one and records premerge Security, and the merge
// op refuses a draft rather than marking it ready.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueState, Revision } from "../../src/state.ts";
import { bodyOf, effectsOf } from "../gh-effects-test-kit.ts";
import { setCurrentRevision } from "./fake-ops-publish-revision.ts";
import { approvalReply, mergeCommentReplies } from "./merge-op-fixtures.ts";
import { finishReplies } from "./ops-finish-fixtures.ts";
import type { World } from "./ops-publish-test-kit.ts";
import {
  boundState,
  fakeGh,
  mergeAuthority,
  PR,
  prView,
  savedListing,
  securityOf,
  sh,
  world,
  writes,
} from "./ops-publish-test-kit.ts";
import { mergedAt } from "./publication-integration-fixtures.ts";

const { policyRevision }: typeof import("../../src/project-policy.ts") =
  await import("../../src/project-policy.ts");
const { merge }: typeof import("../../src/ops/merge.ts") = await import(
  "../../src/ops/merge.ts"
);
const { finishIssue }: typeof import("../../src/ops/finish.ts") = await import(
  "../../src/ops/finish.ts"
);

const SHORT_SHA_LENGTH = 12;
const REVIEWED_CODE = "c0ffee00000000000000000000000000000000aa";
const NOT_AUTHORIZED_REVISION = /is not #7's authorized revision/u;
const NOT_BOUND = /merge authorization .* is not bound to the saved result/u;

// Hardening passed REVIEWED_CODE; the Reviewer's own integration then
// checked the world's head from it.
function chainOf(w: World): { reviewed: Revision; integrated: Revision } {
  return {
    reviewed: { code: REVIEWED_CODE, inputs: "inputs-1" },
    integrated: { code: w.sha, inputs: "inputs-1", ...policyRevision(w.cfg) },
  };
}

function integratedState(
  w: World,
  reviewed: Revision,
  integration: { reviewed: Revision; revision: Revision } | null,
  extra: object = {},
): IssueState {
  return boundState(w, reviewed, { integration, ...extra });
}

function openAt(w: World, revision: Revision): void {
  setCurrentRevision({
    revision,
    baseSha: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
}

// The merge request these tests send; merge parses it from unknown.
interface MergeRequest {
  number: number;
  state: object;
  expectedSha: string;
  expectedBase: string;
  revision: Revision;
  mergeQueue: null;
  summary: string;
}

function mergeRequest(
  w: World,
  revision: Revision,
  state: object,
): MergeRequest {
  return {
    number: 7,
    state,
    expectedSha: w.sha,
    expectedBase: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    revision,
    mergeQueue: null,
    summary: "S",
  };
}

test("merge refuses the Reviewer's integrated head without fresh hardening, writing nothing", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const state = integratedState(w, reviewed, {
    reviewed,
    revision: integrated,
  });
  openAt(w, integrated);
  fakeGh.reply([savedListing(state)]);
  assert.throws(
    () => merge(w.cfg, mergeRequest(w, integrated, state)),
    NOT_AUTHORIZED_REVISION,
  );
  assert.deepEqual(writes(), []);
});

test("merge without an integration says hardening passed on the merged head", () => {
  const w = world();
  const approved = {
    code: w.sha,
    inputs: "inputs-1",
    ...policyRevision(w.cfg),
  };
  openAt(w, approved);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha }),
    approvalReply(w),
    ...mergeAuthority(boundState(w, approved)),
    ...mergeCommentReplies(),
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: w.sha },
    }),
  ]);
  merge(w.cfg, mergeRequest(w, approved, boundState(w, approved)));
  const body = bodyOf(effectsOf(writes()), "comment #50 role=merger");
  assert.ok(
    body.includes(
      `hardening passed on ${approved.code.slice(0, SHORT_SHA_LENGTH)}`,
    ),
  );
  assert.ok(
    body.includes(
      `premerge Security cleared ${approved.code.slice(0, SHORT_SHA_LENGTH)}`,
    ),
  );
  assert.ok(body.includes("without another model review"));
  assert.equal(body.includes("integrated"), false);
});

test("merge refuses a revision the state doesn't authorize, a forged receipt's or a reviewed head included, writing nothing", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  openAt(w, integrated);
  const forged = integratedState(w, reviewed, {
    reviewed: { ...reviewed, code: "0ther" },
    revision: integrated,
  });
  const unbound = integratedState(w, reviewed, null);
  // A review that approved the head, with no hardening, authorizes nothing.
  const unhardened = boundState(w, integrated, { hardened: null });
  for (const state of [
    integratedState(w, reviewed, { reviewed, revision: integrated }),
    forged,
    unbound,
    unhardened,
  ]) {
    fakeGh.reply([
      savedListing(boundState(w, integrated)),
      prView({ headRefOid: w.sha }),
    ]);
    assert.throws(
      () => merge(w.cfg, mergeRequest(w, integrated, state)),
      NOT_AUTHORIZED_REVISION,
    );
    assert.deepEqual(writes(), []);
  }
});

test("merge refuses a draft at the approved head without marking it ready", () => {
  const w = world();
  const approved = {
    code: w.sha,
    inputs: "inputs-1",
    ...policyRevision(w.cfg),
  };
  openAt(w, approved);
  fakeGh.reply([
    savedListing(boundState(w, approved)),
    prView({ headRefOid: w.sha, isDraft: true }),
  ]);
  const reply = merge(
    w.cfg,
    mergeRequest(w, approved, boundState(w, approved)),
  );
  assert.deepEqual(reply, { merged: false, reason: "draft" });
  assert.deepEqual(writes(), []);
});

// The fields a finished merge sets over `state`.
interface DoneFields {
  stage: string;
  lease: null;
  merged: Revision;
}

function doneAt(receipt: Revision, state: object): DoneFields {
  return { ...state, stage: "done", lease: null, merged: receipt };
}

test("a claimed own merge finishes with original hardening and integration intact, only after saved exact security", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const receipt = mergedAt(w, integrated);
  assert.notEqual(reviewed.code, integrated.code);
  assert.notEqual(receipt.code, integrated.code);
  assert.equal(receipt.policy, integrated.policy);
  assert.equal(
    sh(`git --git-dir=${w.root}/origin.git show -s --format=%P ${w.mergeSha}`),
    `${sh(`git -C ${w.worktree} rev-parse origin/integration`)} ${w.sha}`,
  );
  const state = integratedState(
    w,
    reviewed,
    { reviewed, revision: integrated },
    {
      codeMerged: { pr: PR, sha: w.mergeSha },
      verifiedSha: w.mergeSha,
    },
  );
  const uncleared = doneAt(receipt, state);
  fakeGh.reply([savedListing(uncleared)]);
  const refused = finishIssue(w.cfg, { number: 7, state: uncleared });
  assert.equal("reason" in refused && refused.reason, "security");
  assert.deepEqual(writes(), []);

  const done = { ...uncleared, security: securityOf(receipt) };
  const before = structuredClone(done);
  fakeGh.reply([savedListing(done), ...finishReplies()]);
  assert.deepEqual(finishIssue(w.cfg, { number: 7, state: done }), {
    finished: true,
    closed: true,
  });
  assert.ok(
    writes().some((args) => args.join(" ").startsWith("issue close 7 ")),
  );
  assert.equal(
    writes().some(
      (args) =>
        args.join(" ").startsWith("pr merge ") ||
        args.includes("repos/o/r/merges"),
    ),
    false,
  );
  assert.deepEqual(done, before);
  assert.equal(
    sh(`git --git-dir=${w.root}/origin.git rev-parse refs/heads/integration`),
    receipt.code,
  );
});

test("finish refuses an integrated head no receipt binds to the approval, changing nothing", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const forged = integratedState(w, reviewed, {
    reviewed: { ...reviewed, code: "0ther" },
    revision: integrated,
  });
  const receipt = mergedAt(w, integrated);
  const security = securityOf(receipt);
  for (const saved of [forged, integratedState(w, reviewed, null)]) {
    const done = { ...doneAt(receipt, saved), security };
    fakeGh.reply([savedListing(done)]);
    assert.throws(
      () => finishIssue(w.cfg, { number: 7, state: done }),
      NOT_BOUND,
    );
    assert.deepEqual(writes(), []);
  }
});

test("finish of an integrated head refuses a security review of the pre-merge head instead of the merge commit", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const state = integratedState(w, reviewed, {
    reviewed,
    revision: integrated,
  });
  const receipt = mergedAt(w, integrated);
  assert.notEqual(reviewed.code, integrated.code);
  assert.notEqual(receipt.code, integrated.code);
  assert.equal(receipt.policy, integrated.policy);
  assert.equal(
    sh(`git --git-dir=${w.root}/origin.git show -s --format=%P ${w.mergeSha}`),
    `${sh(`git -C ${w.worktree} rev-parse origin/integration`)} ${w.sha}`,
  );
  for (const revision of [integrated, reviewed]) {
    const done = { ...doneAt(receipt, state), security: securityOf(revision) };
    fakeGh.reply([savedListing(done)]);
    const reply = finishIssue(w.cfg, { number: 7, state: done });
    assert.equal("reason" in reply && reply.reason, "security");
    assert.deepEqual(writes(), []);
  }
});
