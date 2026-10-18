// @ts-check
// A stage job at `checks` runs the implementor role's checks entry (#420):
// mock model (the fake RPC pi), fake ops. Passing checks save at accept, or
// at merge after a tests-only rerun; pending CI holds the issue at checks
// with its verified head; a failure runs the CI fixer, pushes, has the fix
// reviewed and verifies again; the CI-fix limit and a fixer's cannot-fix
// stop the issue; a state saved by today's checks stage resumes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  CANNOT_FIX,
  CANNOT_FIX_REASON,
  CLEAN_REVIEW,
  CODE_FLOWS,
  FIXED,
  FIXED_HEAD,
  fixLimit,
  HEAD,
} from "./implementor-checks-test-kit.mjs";
import { claimed } from "./implementor-job-test-kit.mjs";
import {
  logOf,
  piStarts,
  repliesAt,
  runJob,
  setUp,
  USAGE,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const RUN = ["--stage", "checks"];
const ONE_CI_FIX = { maxCiFixes: 1 };
// A CI fix's sessions: the fixer and the two check-fix reviewers.
const FIX_SESSIONS = 3;
const FIX_DIFF = "/w/runs/o__r/issue-7/cifix1.diff";
const LINT_OK = { id: "lint", pass: true, detail: "ok" };
const LINT_BAD = { id: "lint", pass: false, detail: "1 error" };
const CI_PASS = { ok: true, status: "pass" };
const CI_FAIL = {
  ok: true,
  status: "fail",
  failing: ["build"],
  logPath: "/w/runs/o__r/issue-7/ci.log",
};
const PUSH = { ok: true, headSha: FIXED_HEAD, codeChanged: true, wikiAhead: 0 };
const PREPARED = { ok: true, headSha: FIXED_HEAD, diffPath: FIX_DIFF };

/** @param {string} headSha @param {boolean} pass @returns {Record<string, unknown>} the verify op's reply for `headSha` */
function verified(headSha, pass) {
  let checks = [LINT_OK];
  if (!pass) {
    checks = [LINT_BAD];
  }
  return { ok: true, headSha, pass, checks };
}

/** @param {unknown} reply @returns {object[]} a session that spends USAGE and replies `reply` */
function session(reply) {
  return [messageEnd(USAGE), outputEnd(reply)];
}

/**
 * The replies for #7 claimed at checks with a PR, a reviewed head that
 * changes code and `fields` in its state, verify passing and CI green
 * unless `ops` says otherwise.
 * @param {Record<string, unknown>} [fields]
 * @param {Record<string, unknown>} [ops]
 * @returns {{ claim: { paths?: object } } & Record<string, unknown>}
 */
function checksReplies(fields = {}, ops = {}) {
  const replies = repliesAt("checks");
  const state = { reviewedSha: HEAD, flows: CODE_FLOWS, ...fields };
  return {
    ...replies,
    claim: claimed(replies.claim, state),
    verify: verified(HEAD, true),
    "ci-status": CI_PASS,
    push: PUSH,
    "prepare-review": PREPARED,
    ...ops,
  };
}

/** @param {{ stdout: string }} r @returns {any} the job's end, from its summary line */
function endOf(r) {
  const [line = "{}"] = r.stdout.trim().split("\n").slice(-1);
  return JSON.parse(line).end;
}

/** @param {Place} place @param {string} op @returns {any[]} the requests of `op` */
function requestsOf(place, op) {
  return logOf(place, "ops.log").filter((request) => request.op === op);
}

/** @param {Place} place @returns {any} the last state the job saved */
function lastSaved(place) {
  return requestsOf(place, "save-state").at(-1)?.state;
}

/** @param {Place} place @returns {any} the stop op's request, if one ran */
function stopOf(place) {
  return requestsOf(place, "stop").at(-1);
}

test("passing checks save at accept with the verified head and summary, with no session and no sync", () => {
  const place = setUp(checksReplies(), { events: session(FIXED) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "accept" });
  const saved = lastSaved(place);
  assert.equal(saved.stage, "accept");
  assert.equal(saved.verifiedSha, HEAD);
  assert.equal(saved.verifySummary, "lint: ok");
  assert.equal(piStarts(place).length, 0);
  assert.equal(requestsOf(place, "verify").length, 1);
  assert.equal(requestsOf(place, "ci-status")[0]?.expectedSha, HEAD);
  assert.deepEqual(requestsOf(place, "sync-base"), []);
});

test("a tests-only rerun that passes saves at merge with testsOnly cleared", () => {
  const place = setUp(checksReplies({ testsOnly: true }), {
    events: session(FIXED),
  });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "merge" });
  assert.equal(requestsOf(place, "verify")[0]?.testsOnly, true);
  const saved = lastSaved(place);
  assert.equal(saved.stage, "merge");
  assert.equal(saved.testsOnly, false);
});

test("pending CI holds the issue at checks with its verified head, running no session", () => {
  const replies = checksReplies(
    {},
    { "ci-status": { ok: true, status: "pending" } },
  );
  const place = setUp(replies, { events: session(FIXED) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "held" });
  const saved = lastSaved(place);
  assert.equal(saved.stage, "checks");
  assert.equal(saved.verifiedSha, HEAD);
  assert.equal(piStarts(place).length, 0);
  assert.deepEqual(requestsOf(place, "sync-base"), []);
});

test("a failed verify runs the fixer, pushes, has the fix reviewed by two lenses and verifies the new head", () => {
  const verify = {
    sequence: [verified(HEAD, false), verified(FIXED_HEAD, true)],
  };
  const script = {
    launches: [session(FIXED), session(CLEAN_REVIEW), session(CLEAN_REVIEW)],
  };
  const place = setUp(checksReplies({}, { verify }), script);
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "accept" });
  assert.equal(piStarts(place).length, FIX_SESSIONS);
  assert.equal(requestsOf(place, "push").length, 1);
  const [prepare] = requestsOf(place, "prepare-review");
  assert.equal(prepare?.sinceSha, HEAD);
  assert.equal(prepare?.tag, "cifix1");
  assert.equal(requestsOf(place, "verify").length, 2);
  assert.equal(requestsOf(place, "ci-status")[0]?.expectedSha, FIXED_HEAD);
  const saved = lastSaved(place);
  assert.equal(saved.verifiedSha, FIXED_HEAD);
  assert.equal(saved.reviewedSha, FIXED_HEAD);
  assert.equal(saved.headSha, FIXED_HEAD);
  assert.equal(saved.checkpoints?.ciFixRounds, 1);
});

test("checks that still fail past maxCiFixes stop the issue as check-fixes", () => {
  const verify = {
    sequence: [verified(HEAD, false), verified(FIXED_HEAD, false)],
  };
  const script = {
    launches: [session(FIXED), session(CLEAN_REVIEW), session(CLEAN_REVIEW)],
  };
  const place = setUp(checksReplies({}, { verify }), script, ONE_CI_FIX);
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(endOf(r)?.kind, "stopped");
  assert.equal(endOf(r)?.code, "check-fixes");
  assert.equal(stopOf(place)?.reason, fixLimit(1));
  assert.equal(piStarts(place).length, FIX_SESSIONS);
});

test("a fixer that can't fix the checks stops the issue as checks-unrelated, pushing nothing", () => {
  const verify = verified(HEAD, false);
  const place = setUp(checksReplies({}, { verify }), {
    events: session(CANNOT_FIX),
  });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(endOf(r)?.code, "checks-unrelated");
  assert.equal(stopOf(place)?.reason, CANNOT_FIX_REASON);
  assert.equal(stopOf(place)?.detail, CANNOT_FIX.summary);
  assert.deepEqual(requestsOf(place, "push"), []);
});

// A state today's checks stage saved while CI ran on a verified head.
const OLD_CI = {
  phase: "ci",
  verifiedSha: HEAD,
  verifySummary: "lint: ok",
  ciFixes: 1,
  continuations: { ciFix: 1 },
};

test("a state saved by today's checks stage waiting on CI goes straight to CI and saves at accept", () => {
  const place = setUp(checksReplies(OLD_CI), { events: session(FIXED) });
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), { kind: "saved", stage: "accept" });
  assert.deepEqual(requestsOf(place, "verify"), []);
  assert.equal(requestsOf(place, "ci-status").length, 1);
  assert.equal(lastSaved(place).verifySummary, "lint: ok");
  assert.equal(piStarts(place).length, 0);
});

test("today's ciFixes count toward the limit: failing CI at the limit stops with no session", () => {
  const replies = checksReplies(OLD_CI, { "ci-status": CI_FAIL });
  const place = setUp(replies, { events: session(FIXED) }, ONE_CI_FIX);
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(endOf(r)?.code, "check-fixes");
  assert.equal(stopOf(place)?.reason, fixLimit(1));
  assert.equal(piStarts(place).length, 0);
});
