// @ts-check
// A stage job at `fix` runs the implementor role's fix entry (#418): mock
// model (the fake RPC pi), local git origins and fake ops. All findings
// resolved saves at checks with the round's checkpoint and the patch id,
// and the same job goes on to the checks entry (#424);
// findings still open after maxFixRounds stop; a disputed acceptance finding
// stops before any push; a reintroduced finding stops; a fix that adds code
// to an issue whose PR is closed saves at open-pr; a state saved by today's
// fix stage mid-round resumes with its round count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixComment } from "../src/workflow/stages/review-text.ts";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  endOf,
  fixReplies,
  PR,
  requestsOf,
  savedAt,
} from "./implementor-fix-job-test-kit.mjs";
import {
  ACC,
  FIX_DISPUTES_ACC,
  FIX_DONE,
  PATCH_ID,
  REINTRODUCED,
  REINTRODUCED_REASON,
  RESOLVED,
  REVIEWED,
  remainReason,
  UNRESOLVED,
} from "./implementor-fix-test-kit.mjs";
import { PUSHED } from "./implementor-job-test-kit.mjs";
import { logOf, piStarts, runJob, setUp, USAGE } from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const RUN = ["--stage", "fix"];
const PR_OPS = ["open-pr", "start-pr", "close-pr"];
const ONE_ROUND = { maxFixRounds: 1 };
const DEFAULT_ROUNDS = 2;
const TWO_SESSIONS = 2;
// How a re-reviewer's comment starts (review-text.ts rereviewComment).
const REREVIEW_COMMENT = /^Re-review of the fix in bbbbbbb\./mu;

/** @param {unknown} reply @returns {object[]} a session that spends USAGE and replies `reply` */
function session(reply) {
  return [messageEnd(USAGE), outputEnd(reply)];
}

/** @param {unknown[]} replies @returns {{ launches: object[][] }} one session per reply, in order */
function sessions(replies) {
  return { launches: replies.map(session) };
}

/** @param {Place} place @returns {any} the last state the job saved */
function lastSaved(place) {
  return requestsOf(place, "save-state").at(-1)?.state;
}

/** @param {Place} place @returns {any} the stop op's request, if one ran */
function stopOf(place) {
  return requestsOf(place, "stop").at(-1);
}

/** @param {Place} place @returns {string[]} the PR ops the job sent */
function prOpsOf(place) {
  return logOf(place, "ops.log")
    .map(({ op }) => String(op))
    .filter((op) => PR_OPS.includes(op));
}

/** @param {{ id: string, status: string }[]} findings @returns {{ id: string, status: string }[]} each finding's id and status */
function statusesOf(findings) {
  return findings.map(({ id, status }) => ({ id, status }));
}

/** @param {Place} place @returns {any[]} every comment the post op was asked to post */
function postedComments(place) {
  return requestsOf(place, "post").flatMap(({ comments = [] }) => comments);
}

test("all findings resolved saves at checks with the round, the reviewed head and its patch id, then runs checks", () => {
  const place = setUp(fixReplies(), sessions([FIX_DONE, RESOLVED]));
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "accept" });
  assert.equal(piStarts(place).length, TWO_SESSIONS);
  assert.equal(requestsOf(place, "push").length, 1);
  const [prepare] = requestsOf(place, "prepare-review");
  assert.equal(prepare?.sinceSha, REVIEWED);
  assert.equal(prepare?.tag, "r1");
  assert.deepEqual(prOpsOf(place), []);
  const saved = savedAt(place, "checks");
  assert.equal(saved.reviewedSha, PUSHED);
  assert.equal(saved.reviewedPatchId, PATCH_ID);
  assert.equal(saved.testsOnly, false);
  assert.equal(saved.round, 1);
  assert.equal(saved.checkpoints?.fixRounds, 1);
  assert.deepEqual(statusesOf(saved.findings), [
    { id: "f1", status: "resolved" },
  ]);
  const comments = postedComments(place);
  const fixer = comments.find(({ body }) =>
    body.includes(fixComment(FIX_DONE)),
  );
  assert.equal(fixer?.number, PR);
  const rereviewer = comments.find(({ body }) => REREVIEW_COMMENT.test(body));
  assert.equal(rereviewer?.number, PR);
});

test("findings still open after maxFixRounds stop with the generic reason", () => {
  const place = setUp(
    fixReplies(),
    sessions([FIX_DONE, UNRESOLVED]),
    ONE_ROUND,
  );
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "stopped", code: "review-rounds" });
  assert.equal(piStarts(place).length, TWO_SESSIONS);
  const stop = stopOf(place);
  assert.equal(stop.code, "review-rounds");
  assert.equal(stop.reason, remainReason(1));
  assert.equal(lastSaved(place).checkpoints?.fixRounds, 1);
});

test("a disputed acceptance finding stops as acceptance before any push", () => {
  const place = setUp(
    fixReplies({ findings: [ACC] }),
    sessions([FIX_DISPUTES_ACC]),
  );
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "stopped", code: "acceptance" });
  assert.equal(piStarts(place).length, 1);
  assert.deepEqual(requestsOf(place, "push"), []);
  assert.equal(stopOf(place).code, "acceptance");
});

test("a reintroduced finding stops as a fix loop", () => {
  const place = setUp(fixReplies(), sessions([FIX_DONE, REINTRODUCED]));
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "stopped", code: "fix-loop" });
  assert.equal(stopOf(place).reason, REINTRODUCED_REASON);
});

test("a fix that adds code to an issue whose PR is closed saves at open-pr, sending no PR op", () => {
  const fields = { prClosed: true, flows: { code: false, wiki: true } };
  const place = setUp(fixReplies(fields), sessions([FIX_DONE]));
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "open-pr" });
  assert.equal(piStarts(place).length, 1);
  assert.deepEqual(requestsOf(place, "prepare-review"), []);
  assert.deepEqual(prOpsOf(place), []);
  assert.equal(lastSaved(place).stage, "open-pr");
});

test("a state saved mid-round by today's fix stage at its last round stops with no session", () => {
  const fields = { round: DEFAULT_ROUNDS, phase: "rereviewed" };
  const place = setUp(fixReplies(fields), sessions([FIX_DONE, RESOLVED]));
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "stopped", code: "review-rounds" });
  assert.deepEqual(piStarts(place), []);
  assert.equal(stopOf(place).reason, remainReason(DEFAULT_ROUNDS));
});
