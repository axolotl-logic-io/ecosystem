// @ts-check
// The implementor's `fix` entry in a stage job (#418, #424): the ops replies
// for issue #7 claimed at fix after a review with F1 open, a push that
// changes code, the re-review diff, and the checks the same job runs once
// every finding is resolved (verify passing and CI green), and how a test
// reads the job's end and its ops requests.
import {
  DIFF_PATH,
  F1,
  PATCH_ID,
  REVIEWED,
  SPEC,
} from "./implementor-fix-test-kit.mjs";
import { claimed, PUSHED } from "./implementor-job-test-kit.mjs";
import { logOf, repliesAt } from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

// The PR the claimed issue has.
const PR = 42;
// The verify op's reply for the pushed head, and CI's.
const VERIFIED = {
  ok: true,
  headSha: PUSHED,
  pass: true,
  checks: [{ id: "lint", pass: true, detail: "ok" }],
};
const CI_PASS = { ok: true, status: "pass" };

/**
 * The replies for #7 claimed at fix with `fields` in its state.
 * @param {Record<string, unknown>} [fields]
 * @returns {{ claim: { paths?: object } } & Record<string, unknown>}
 */
function fixReplies(fields = {}) {
  const replies = repliesAt("fix");
  const state = {
    spec: SPEC,
    pr: PR,
    headSha: REVIEWED,
    reviewedSha: REVIEWED,
    findings: [F1],
    nextFindingId: 1,
    resolvedHistory: [],
    round: 0,
    flows: { code: true, wiki: false },
    ...fields,
  };
  const push = { ok: true, headSha: PUSHED, codeChanged: true, wikiAhead: 0 };
  const prepared = {
    ok: true,
    headSha: PUSHED,
    diffPath: DIFF_PATH,
    diffLines: "4",
    patchId: PATCH_ID,
  };
  return {
    ...replies,
    claim: claimed(replies.claim, state),
    push,
    "prepare-review": prepared,
    verify: VERIFIED,
    "ci-status": CI_PASS,
  };
}

/** @param {{ stdout: string }} r @returns {unknown} the job's end, from its summary line */
function endOf(r) {
  const [line = "{}"] = r.stdout.trim().split("\n").slice(-1);
  return JSON.parse(line).end;
}

/** @param {Place} place @param {string} op @returns {any[]} the requests of `op` */
function requestsOf(place, op) {
  return logOf(place, "ops.log").filter((request) => request.op === op);
}

/** @param {Place} place @param {string} stage @returns {any} the last state the job saved at `stage` */
function savedAt(place, stage) {
  return requestsOf(place, "save-state")
    .map(({ state }) => state)
    .findLast((state) => state.stage === stage);
}

export { endOf, fixReplies, PR, requestsOf, savedAt, VERIFIED };
