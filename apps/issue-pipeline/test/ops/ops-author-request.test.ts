// The real claim op persists optional Author intent; no launch stub grants it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { IssueState, MergeAttempt } from "../../src/state.ts";
import type { GhReply } from "../fake-gh.ts";
import { loseOwnership } from "../fake-ownership.ts";
import {
  claimMutationReplies,
  collaboratorReply,
} from "../gh-mutation-fixtures.ts";
import { historyReply } from "../initial-write-state-fixtures.ts";
import { issueReply } from "../ops-claim-test-kit.ts";
import {
  commitOnOrigin,
  everyCommentsRead,
  kit,
  LANE,
  myClaim,
  prView,
  savedStates,
} from "../ops-v2-test-kit.ts";

const {
  askOps,
  reply,
  savedStateComment,
  writes,
  root,
  sh,
  worktree,
}: typeof import("../ops-cli-test-kit.ts") = kit;
kit.requireGhReplies();
const { ISSUE_STATE, newIssueState }: typeof import("../../src/state.ts") =
  await import("../../src/state.ts");
const CLAIMED = z.looseObject({ ok: z.literal(true), state: ISSUE_STATE });
const FAILED = z.object({ ok: z.literal(false), error: z.string() });
const PR = 7;
const STATE_COMMENT = 1;
const CLAIM_COMMENT = 2;
// What an owner whose issue a successor took reads (coordination-records.ts).
const RELEASED = /released instance cannot request again/u;
const FIRST_ISSUE = 701;
const REFUSED_ISSUE = 710;
const SHA_LENGTH = 40;
const INPUTS_LENGTH = 64;
const INPUTS = "a".repeat(INPUTS_LENGTH);
const CODE = "b".repeat(SHA_LENGTH);
const REVISION: { code: string; inputs: string } = {
  code: CODE,
  inputs: INPUTS,
};
const ATTEMPT: MergeAttempt = {
  repo: "o/r",
  pr: PR,
  target: "integration",
  branch: `agent/issue-${REFUSED_ISSUE}`,
  authorized: REVISION,
  hardened: REVISION,
  integration: null,
  result: null,
  reads: 0,
};
const REFUSED = /cannot switch to Author/u;

function savedDirect(number: number, fields: object = {}): IssueState {
  return ISSUE_STATE.parse({
    ...newIssueState(number),
    stage: "review",
    pr: PR,
    headSha: CODE,
    branch: `agent/issue-${number}`,
    requirementsInputs: INPUTS,
    hardened: REVISION,
    integration: { reviewed: REVISION, revision: REVISION },
    counts: { conflictFixes: 1, syncs: 2 },
    ...fields,
  });
}

function claimWorld(state: IssueState, extra: readonly GhReply[] = []): void {
  reply([
    collaboratorReply("o/r", "alice"),
    issueReply(state.number),
    everyCommentsRead(state.number, [
      savedStateComment(STATE_COMMENT, state),
      myClaim(CLAIM_COMMENT),
    ]),
    ...extra,
  ]);
}

for (const [offset, stage] of (
  ["implement", "review", "merge"] as const
).entries()) {
  test(`real claim checkpoints direct ${stage} for explicit Author without resetting local or remote work`, () => {
    const number = FIRST_ISSUE + offset;
    const branch = `agent/issue-${number}`;
    const sha = commitOnOrigin(branch, `work-${number}.txt`);
    const revision = { code: sha, inputs: INPUTS };
    const saved = savedDirect(number, {
      stage,
      headSha: sha,
      hardened: revision,
      integration: { reviewed: revision, revision },
    });
    claimWorld(saved, [
      prView(number, PR, { headRefOid: sha }),
      ...claimMutationReplies(number, STATE_COMMENT, PR),
    ]);
    const result = CLAIMED.parse(
      askOps({ op: "claim", number, stage: "author", ...LANE }),
    );
    assert.equal(result.state.stage, "author");
    assert.equal(result.state.authorUsed, true);
    assert.equal(result.state.resumeStage, stage);
    assert.equal(result.state.pr, PR);
    assert.equal(result.state.headSha, sha);
    assert.equal(result.state.branch, branch);
    assert.deepEqual(result.state.hardened, saved.hardened);
    assert.deepEqual(result.state.integration, saved.integration);
    assert.deepEqual(result.state.counts, saved.counts);
    const durable = ISSUE_STATE.parse(savedStates().at(-1));
    assert.equal(durable.stage, "author");
    assert.equal(durable.resumeStage, stage);
    assert.equal(sh(`git -C ${worktree(number)} rev-parse HEAD`), sha);
    assert.equal(sh(`git -C ${root}/origin.git rev-parse ${branch}`), sha);
    const local = path.join(worktree(number), "retained.txt");
    fs.writeFileSync(local, "uncommitted recovery\n");
    claimWorld(durable, [
      prView(number, PR, { headRefOid: sha }),
      ...claimMutationReplies(number, STATE_COMMENT, PR),
    ]);
    const retry = CLAIMED.parse(
      askOps({ op: "claim", number, stage: "author", ...LANE }),
    );
    assert.equal(retry.state.resumeStage, stage);
    assert.equal(fs.readFileSync(local, "utf8"), "uncommitted recovery\n");
    assert.deepEqual(retry.state.hardened, saved.hardened);
  });
}

for (const fields of [
  { stage: "done" },
  { codeMerged: { pr: PR, sha: CODE } },
  { merged: REVISION },
  {
    security: {
      revision: REVISION,
      commentId: 3,
      finding: { category: "abuse-risk", reason: "Unsafe" },
    },
  },
  { mergeAttempt: ATTEMPT },
  { mergeAttempt: { ...ATTEMPT, result: CODE, reads: 1 } },
]) {
  test(`real claim refuses explicit Author over durable completion/merge/rejection ${JSON.stringify(fields)}`, () => {
    const state = savedDirect(REFUSED_ISSUE, fields);
    claimWorld(state);
    const result = FAILED.parse(
      askOps({ op: "claim", number: REFUSED_ISSUE, stage: "author", ...LANE }),
    );
    assert.match(result.error, REFUSED);
    assert.deepEqual(writes(), []);
    assert.equal(fs.existsSync(worktree(REFUSED_ISSUE)), false);
  });
}

for (const status of ["MERGED", "CLOSED"] as const) {
  test(`real claim refuses explicit Author when current PR is ${status} before it has a saved merge fact`, () => {
    const state = savedDirect(REFUSED_ISSUE);
    let mergeCommit: { oid: string } | null = null;
    if (status === "MERGED") {
      mergeCommit = { oid: CODE };
    }
    claimWorld(state, [
      prView(REFUSED_ISSUE, PR, { state: status, mergeCommit }),
    ]);
    const result = FAILED.parse(
      askOps({ op: "claim", number: REFUSED_ISSUE, stage: "author", ...LANE }),
    );
    assert.match(result.error, REFUSED);
    assert.deepEqual(writes(), []);
    assert.equal(fs.existsSync(worktree(REFUSED_ISSUE)), false);
  });
}

test("an unreadable live PR cannot create explicit Author authority", () => {
  claimWorld(savedDirect(REFUSED_ISSUE), [
    { when: `pr view ${PR} `, code: 1, stderr: "HTTP 422: unreadable PR" },
  ]);
  const result = FAILED.parse(
    askOps({ op: "claim", number: REFUSED_ISSUE, stage: "author", ...LANE }),
  );
  assert.ok(result.error.includes("unreadable PR"));
  assert.deepEqual(writes(), []);
});

test("explicit Author still loses to another invocation that takes the issue, without mode or checkpoint writes", () => {
  const state = savedDirect(REFUSED_ISSUE);
  reply([
    collaboratorReply("o/r", "alice"),
    historyReply(REFUSED_ISSUE),
    issueReply(REFUSED_ISSUE),
    everyCommentsRead(REFUSED_ISSUE, [savedStateComment(STATE_COMMENT, state)]),
    prView(REFUSED_ISSUE, PR),
  ]);
  const request = {
    op: "claim",
    number: REFUSED_ISSUE,
    stage: "author",
    ...LANE,
  };
  loseOwnership();
  const result = FAILED.parse(askOps(request));
  assert.match(result.error, RELEASED);
  assert.deepEqual(writes(), []);
});
