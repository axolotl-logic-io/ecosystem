// The acceptance, security review and merge scenarios' shared run: issue #7
// claimed at a finishing stage with its checks passed, run through the built
// workflow, and its one summary item.
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  sweepReply,
  sweepSummary,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

// Issue #7 with its checks passed at fffffff.
const CHECKED = {
  pr: 42,
  headSha: "fffffff",
  reviewedSha: "fffffff",
  verifiedSha: "fffffff",
  verifySummary: "test: passed",
  implemented: true,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  allocated: 820_000,
};
// Issue #7 with acceptance passed.
const ACCEPTED = {
  ...CHECKED,
  acceptReason: "Does what #7 asks.",
  allocated: 880_000,
};
// Issue #7 with the security review passed.
const SECURED = { ...ACCEPTED, allocated: 940_000 };

// A run of issue #7 claimed at `stage` with `fields`, with ops and agents.
function finishRun({ stage, fields, ops = {}, agents = {}, config = {} }) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config }),
      claim: claimAt(stage, fields),
      ...ops,
    },
    agents,
  });
}

// The one summary item of issue #7, with `fields` replacing the defaults.
function issueSummary(fields) {
  return sweepSummary({
    items: [
      { issue: 7, pr: 42, outcome: "in-progress", reason: null, ...fields },
    ],
  });
}

export { ACCEPTED, CHECKED, finishRun, issueSummary, SECURED };
