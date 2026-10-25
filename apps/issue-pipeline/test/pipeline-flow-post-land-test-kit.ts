// What real full-flow runs did around Land (#185): checks and Security clear
// the exact candidate before the target moves; after it, only read-only
// confirmation runs, never a suite, Security bundle or model.
import { z } from "zod";
import type { IssueState } from "../src/state.ts";
import type { World } from "./fake-pipeline-flow-gh-world.ts";
import { opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { ISSUE } from "./pipeline-flow-test-kit.ts";

const CONFIRMED = z.object({
  confirmed: z.boolean(),
  headSha: z.string().optional(),
});

//  confirm-merged's replies since `traceStart`.
function confirmationsSince(
  flow: Flow,
  traceStart: number,
): { confirmed: boolean; headSha?: string | undefined }[] {
  return opsTrace(flow)
    .slice(traceStart)
    .filter(({ request }) => request.op === "confirm-merged")
    .map(({ reply }) => CONFIRMED.parse(reply));
}

const PASSED = z.looseObject({ pass: z.literal(true), headSha: z.string() });

//  The order #185 promises around a Land of the exact candidate.
const PREMERGE_ONLY = {
  checkedBeforeSecurity: true,
  securityBeforeLand: true,
  suiteAfterLand: false,
  bundleAfterLand: false,
  confirmedAfterLand: true,
};

// The order of the flow's last Land: the last passing verify of exactly
// `code`, the last Security bundle, the merge op and the ops after it.
function landOrder(
  flow: Flow,
  code: string,
): {
  checkedBeforeSecurity: boolean;
  securityBeforeLand: boolean;
  suiteAfterLand: boolean;
  bundleAfterLand: boolean;
  confirmedAfterLand: boolean;
} {
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

// A saved state's evidence that must survive Land unchanged.
type LandedEvidence = Pick<
  IssueState,
  "merged" | "codeMerged" | "security" | "mergeAttempt"
>;

//  Evidence that must survive Land unchanged.
function landedEvidence({
  merged,
  codeMerged,
  security,
  mergeAttempt,
}: LandedEvidence): LandedEvidence {
  return { merged, codeMerged, security, mergeAttempt };
}

//  The flow's op names since `traceStart`.
function opsSince(flow: Flow, traceStart: number): string[] {
  return opsTrace(flow)
    .slice(traceStart)
    .map(({ request }) => request.op);
}

// A read-only post-Land run: no suite, writer or merge, and these
// confirm-merged replies.
function readOnlyAfterLand(
  confirmations: { confirmed: boolean; headSha?: string }[],
): {
  verified: never[];
  confirmations: { confirmed: boolean; headSha?: string }[];
  forbidden: never[];
  merges: number;
} {
  return { verified: [], confirmations, forbidden: [], merges: 0 };
}

// The same facts of a replay (pipeline-flow-replay-test-kit.ts).
function postLandFacts({
  verified,
  confirmations,
  forbidden,
  merges,
}: {
  verified: unknown[];
  confirmations: unknown[];
  forbidden: string[];
  merges: number;
}): {
  verified: unknown[];
  confirmations: unknown[];
  forbidden: string[];
  merges: number;
} {
  return { verified, confirmations, forbidden, merges };
}

//  The flow issue's GitHub state.
function issueStateIn(world: World): "open" | "closed" | undefined {
  return world.issues.find(({ number }) => number === ISSUE)?.state;
}

export type { LandedEvidence };
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
