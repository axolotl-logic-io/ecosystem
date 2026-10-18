// @ts-check
// The claim of a done issue, through the ops CLI, which claims it only to
// reconcile its completion: GitHub must report the same code merge the done
// state saved, and a change that lives only in the wiki saved none, so
// GitHub must report none. ops-v2-test-kit (through ops-cli-test-kit) sets a
// temporary HOME and pipeline root before any pipeline module loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  everyCommentsRead,
  kit,
  LANE,
  myClaim,
  openIssue,
  prView,
  savedStates,
  v2State,
} from "./ops-v2-test-kit.mjs";

const { askOps, reply, stateComment, writes } = kit;
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

// gh's answer to the list of issue `n`'s branch's open PRs: none.
/** @param {number} n @returns {import("./fake-gh.mjs").GhReply} */
function noOpenPr(n) {
  return {
    when: `pr list -R o/r --head agent/issue-${n} --state open`,
    stdout: "[]",
    keep: true,
  };
}

// Claims issue `n`, done with `saved`, which this lane already holds, with
// GitHub's `more` replies.
/** @param {number} n @param {object} saved @param {readonly import("./fake-gh.mjs").GhReply[]} more @returns {unknown} */
function claimDone(n, saved, more) {
  reply([
    openIssue(n),
    ...more,
    everyCommentsRead(n, [stateComment(1, saved), myClaim(2)]),
  ]);
  return askOps({ op: "claim", number: n, ...LANE });
}

test("a done wiki-only change with no PR and no code merge on GitHub is claimed to finish it", () => {
  const n = 321;
  const merged = { code: null, wiki: WIKI_OID, inputs: "x" };
  const answer = claimDone(
    n,
    v2State(n, { stage: "done", flows: { code: false, wiki: true }, merged }),
    [noOpenPr(n)],
  );
  assert.equal(ANSWER.parse(answer).error, undefined);
  const won = CLAIMED.parse(answer);
  assert.equal(won.state.stage, "done");
  assert.equal(won.state.pr, null);
  assert.equal(won.state.codeMerged, null);
  assert.deepEqual(won.state.merged, merged);
  assert.deepEqual(
    savedStates().map((saved) => CLAIMED.shape.state.parse(saved).merged),
    [merged],
  );
  assert.equal(
    writes().some((args) => args.join(" ").includes("agent:working")),
    false,
  );
});

test("a done code change whose PR GitHub doesn't report merged is refused", () => {
  const n = 322;
  const merged = { code: MERGE_OID, wiki: null, inputs: "x" };
  const failed = FAILED.parse(
    claimDone(n, v2State(n, { stage: "done", pr: PR, merged }), [
      prView(n, PR),
    ]),
  );
  assert.match(failed.error, UNCONFIRMED);
  assert.deepEqual(writes(), []);
});

test("a done code change GitHub reports merged at another commit is refused", () => {
  const n = 323;
  const merged = { code: MERGE_OID, wiki: null, inputs: "x" };
  const failed = FAILED.parse(
    claimDone(n, v2State(n, { stage: "done", pr: PR, merged }), [
      prView(n, PR, { state: "MERGED", mergeCommit: { oid: OTHER_OID } }),
    ]),
  );
  assert.match(failed.error, UNCONFIRMED);
  assert.deepEqual(writes(), []);
});

test("a done wiki-only change whose PR GitHub reports merged is refused", () => {
  const n = 324;
  const merged = { code: null, wiki: WIKI_OID, inputs: "x" };
  const failed = FAILED.parse(
    claimDone(n, v2State(n, { stage: "done", pr: PR, merged }), [
      prView(n, PR, { state: "MERGED", mergeCommit: { oid: MERGE_OID } }),
    ]),
  );
  assert.match(failed.error, UNCONFIRMED);
  assert.deepEqual(writes(), []);
});
