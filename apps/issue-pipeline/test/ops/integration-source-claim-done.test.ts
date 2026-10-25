// The claim of a done issue, through the ops CLI, which claims it only to
// reconcile its completion: GitHub must report the same code merge the done
// state saved, and a legacy change that lived only in the wiki (saved while
// the pipeline had one) saved none, so GitHub must report none. ops-v2-test-kit (through ops-cli-test-kit) sets a
// temporary HOME and pipeline root before any pipeline module loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { GhReply } from "../fake-gh.ts";
import { collaboratorReply } from "../gh-mutation-fixtures.ts";
import {
  everyCommentsRead,
  kit,
  LANE,
  myClaim,
  openIssue,
  prView,
  receiptCheckpoint,
  savedStates,
  v2State,
} from "../ops-v2-test-kit.ts";

kit.requireGhReplies();
const {
  askOps,
  reply,
  savedStateComment,
  writes,
}: typeof import("../ops-cli-test-kit.ts") = kit;
const SHA_LENGTH = 40;
const MERGE_OID = "a".repeat(SHA_LENGTH);
const OTHER_OID = "b".repeat(SHA_LENGTH);
const WIKI_OID = "d".repeat(SHA_LENGTH);
const PR = 7;
const UNCONFIRMED = /is done, but GitHub doesn't confirm the merge it saved/u;

const CLAIMED = z.looseObject({
  ok: z.literal(true),
  state: z.looseObject({
    stage: z.string(),
    pr: z.number().nullable(),
    codeMerged: z.unknown(),
    merged: z.unknown(),
  }),
});
const FAILED = z.looseObject({ ok: z.literal(false), error: z.string() });
const ANSWER = z.looseObject({ error: z.string().optional() });

// gh's answer to the list of issue `n`'s branch's all-state PR history: none.
function noPrHistory(n: number): GhReply {
  return {
    when: `pr list -R o/r --head agent/issue-${n} --state all`,
    stdout: "[]",
    keep: true,
  };
}

// Claims issue `n`, done with `saved`, which this lane already holds, with
// GitHub's `more` replies.
function claimDone(
  n: number,
  saved: object,
  more: readonly GhReply[],
): unknown {
  reply([
    collaboratorReply("o/r", "alice"),
    {
      when: "api -X PATCH repos/o/r/issues/comments/1 -f",
      stdout: "",
      keep: true,
    },
    openIssue(n),
    ...more,
    everyCommentsRead(n, [savedStateComment(1, saved), myClaim(2)]),
  ]);
  return askOps({ op: "claim", number: n, ...LANE });
}

test("a legacy done wiki-only change with no PR and no code merge on GitHub is claimed to finish it", () => {
  const n = 321;
  const merged = { code: null, wiki: WIKI_OID, inputs: "x" };
  const answer = claimDone(
    n,
    v2State(n, { stage: "done", flows: { code: false, wiki: true }, merged }),
    [noPrHistory(n)],
  );
  assert.equal(ANSWER.parse(answer).error, undefined);
  const won = CLAIMED.parse(answer);
  assert.equal(won.state.stage, "done");
  assert.equal(won.state.pr, null);
  assert.equal(won.state.codeMerged, null);
  assert.deepEqual(won.state.merged, merged);
  assert.deepEqual(
    savedStates().map((saved) => CLAIMED.shape.state.parse(saved).merged),
    [merged, merged],
    "the receipt checkpoint, then the claimed state",
  );
  assert.equal(
    writes().some((args) => args.join(" ").includes("agent:working")),
    false,
  );
});

test("a done code change whose PR GitHub doesn't report merged is refused", () => {
  const n = 322;
  const merged = { code: MERGE_OID, inputs: "x" };
  const saved = v2State(n, { stage: "done", pr: PR, merged });
  const failed = FAILED.parse(claimDone(n, saved, [prView(n, PR)]));
  assert.match(failed.error, UNCONFIRMED);
  assert.deepEqual(savedStates(), [receiptCheckpoint(saved)]);
  assert.equal(writes().length, 1);
});

test("a done code change GitHub reports merged at another commit is refused", () => {
  const n = 323;
  const merged = { code: MERGE_OID, inputs: "x" };
  const saved = v2State(n, { stage: "done", pr: PR, merged });
  const failed = FAILED.parse(
    claimDone(n, saved, [
      prView(n, PR, { state: "MERGED", mergeCommit: { oid: OTHER_OID } }),
    ]),
  );
  assert.match(failed.error, UNCONFIRMED);
  assert.deepEqual(savedStates(), [receiptCheckpoint(saved)]);
  assert.equal(writes().length, 1);
});

test("a legacy done wiki-only change whose PR GitHub reports merged is refused", () => {
  const n = 324;
  const merged = { code: null, wiki: WIKI_OID, inputs: "x" };
  const saved = v2State(n, { stage: "done", pr: PR, merged });
  const failed = FAILED.parse(
    claimDone(n, saved, [
      prView(n, PR, { state: "MERGED", mergeCommit: { oid: MERGE_OID } }),
    ]),
  );
  assert.match(failed.error, UNCONFIRMED);
  assert.deepEqual(savedStates(), [receiptCheckpoint(saved)]);
  assert.equal(writes().length, 1);
});
