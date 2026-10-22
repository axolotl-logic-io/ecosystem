// @ts-check
// What real full-flow runs did around Land (#185): checks and Security clear
// the exact candidate before the target moves; after it, only read-only
// confirmation runs, never a suite, Security bundle or model.
import { z } from "zod";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { ISSUE } from "./pipeline-flow-test-kit.mjs";

/** @typedef {import("./pipeline-flow-test-kit.mjs").Flow} Flow */
const CONFIRMED = z.object({
  confirmed: z.boolean(),
  headSha: z.string().optional(),
});

/** confirm-merged's replies since `traceStart`. @param {Flow} flow @param {number} traceStart */
function confirmationsSince(flow, traceStart) {
  return opsTrace(flow)
    .slice(traceStart)
    .filter(({ request }) => request.op === "confirm-merged")
    .map(({ reply }) => CONFIRMED.parse(reply));
}

const PASSED = z.looseObject({ pass: z.literal(true), headSha: z.string() });

/** The order #185 promises around a Land of the exact candidate. */
const PREMERGE_ONLY = {
  checkedBeforeSecurity: true,
  securityBeforeLand: true,
  suiteAfterLand: false,
  bundleAfterLand: false,
  confirmedAfterLand: true,
};

/**
 * The order of the flow's last Land: the last passing verify of exactly
 * `code`, the last Security bundle, the merge op and the ops after it.
 * @param {Flow} flow @param {string} code
 */
function landOrder(flow, code) {
  const trace = opsTrace(flow);
  const landed = trace.findLastIndex(({ request }) => request.op === "merge");
  const checked = trace.findLastIndex(
    ({ request, reply }) =>
      request.op === "verify" && PASSED.safeParse(reply).data?.headSha === code,
  );
  const bundled = trace.findLastIndex(
    ({ request }) => request.op === "prepare-review",
  );
  const afterLand = trace.slice(landed + 1).map(({ request }) => request.op);
  return {
    checkedBeforeSecurity: checked >= 0 && checked < bundled,
    securityBeforeLand: bundled >= 0 && bundled < landed,
    suiteAfterLand: afterLand.includes("verify"),
    bundleAfterLand: afterLand.includes("prepare-review"),
    confirmedAfterLand: afterLand.includes("confirm-merged"),
  };
}

/** Evidence that must survive Land unchanged. @param {any} state */
function landedEvidence({ merged, codeMerged, security, mergeAttempt }) {
  return { merged, codeMerged, security, mergeAttempt };
}

/** The flow's op names since `traceStart`. @param {Flow} flow @param {number} traceStart */
function opsSince(flow, traceStart) {
  return opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
}

/**
 * A read-only post-Land run: no suite, writer or merge, and these
 * confirm-merged replies.
 * @param {{ confirmed: boolean, headSha?: string }[]} confirmations
 */
function readOnlyAfterLand(confirmations) {
  return { verified: [], confirmations, forbidden: [], merges: 0 };
}

/**
 * The same facts of a replay (pipeline-flow-replay-test-kit.mjs).
 * @param {{ verified: unknown[], confirmations: unknown[], forbidden: string[], merges: number }} facts
 */
function postLandFacts({ verified, confirmations, forbidden, merges }) {
  return { verified, confirmations, forbidden, merges };
}

/** The flow issue's GitHub state. @param {import("./fake-pipeline-flow-gh-world.mjs").World} world */
function issueStateIn(world) {
  return world.issues.find(({ number }) => number === ISSUE)?.state;
}

export {
  confirmationsSince,
  issueStateIn,
  landedEvidence,
  landOrder,
  opsSince,
  PREMERGE_ONLY,
  postLandFacts,
  readOnlyAfterLand,
};
