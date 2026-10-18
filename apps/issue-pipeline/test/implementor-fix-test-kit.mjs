// @ts-check
// The implementor's `fix` entry for issue #7 (#418): the findings a review
// leaves open, the fixer's and re-reviewers' replies as their sessions give
// them, the data locate builds from a state saved at `fix`, a step through
// `transition`, and the stop reasons today's fix and rereview stages give.
import { locate } from "../src/roles/implementor/locate.ts";
import { transition } from "../src/roles/implementor/machine.ts";
import { implContext } from "./implementor-role-test-kit.mjs";

/** @import { State } from "../src/state.ts" */
/** @import { Step } from "../src/roles/machine.ts" */
/** @import { RoleContext } from "../src/roles/walk.ts" */
/** @import { ImplData, ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { ImplResult } from "../src/roles/implementor/machine.ts" */
/** @import { FixReply } from "../src/workflow/stages/review-replies.ts" */

/**
 * A finding as the state stores it (src/workflow/types.ts Finding), as a
 * type literal so a saved state's findings take it.
 * @typedef {{ id: string, file: string, line: number, title: string, evidence: string, suggestion: string, lenses: string[], category: string | null, status: "open" | "resolved", disputed: boolean, dispute?: string }} Finding
 */

const SPEC = "## Behaviour\n\n1. src/a.ts does the thing.";
// The head the review saw, and the head the fix pushes.
const REVIEWED = "rrrrrrr";
const FIXED_HEAD = "bbbbbbb";
// The re-review diff prepare-review gives, and its patch id.
const DIFF_PATH = "/runs/issue-7/review-r1/diff.patch";
const PATCH_ID = "p1p1p1p1";

/** @param {Partial<Finding>} fields @returns {Finding} an open finding */
function finding(fields) {
  return {
    id: "f1",
    file: "src/a.ts",
    line: 3,
    title: "Off by one",
    evidence: "The loop skips the last item.",
    suggestion: "Use <= in the bound.",
    lenses: ["correctness"],
    category: null,
    status: "open",
    disputed: false,
    ...fields,
  };
}

// A correctness finding, a security finding with its harm, and the finding a
// failed acceptance check raises.
const F1 = finding({});
const SEC = finding({
  id: "f2",
  title: "Leaks the token",
  evidence: "It logs the token.",
  suggestion: "Drop the log line.",
  lenses: ["security"],
  category: "user-harm",
});
const ACC = finding({
  id: "f3",
  file: "",
  line: 0,
  title: "acceptance: issue not fully resolved",
  evidence: "The issue asks for a CSV export; there is none.",
  suggestion: "Add the export.",
  lenses: ["acceptance"],
});

// The fixer's replies (FIX_SCHEMA).
/** @type {FixReply} */
const FIX_DONE = {
  status: "done",
  fixed: ["f1"],
  disputed: [],
  summary: "Fixed the off-by-one.",
};
/** @type {FixReply} */
const FIX_HANDOFF = {
  status: "handoff",
  fixed: [],
  disputed: [],
  summary: "Half done.",
};
const DISPUTE = { id: "f3", evidence: "The export is in src/csv.ts." };
/** @type {FixReply} */
const FIX_DISPUTES_ACC = {
  status: "done",
  fixed: [],
  disputed: [DISPUTE],
  summary: "Disputed f3.",
};

// The re-reviewers' replies (REREVIEW_SCHEMA).
const RESOLVED = {
  results: [{ id: "f1", status: "resolved", note: "" }],
  newFindings: [],
};
const UNRESOLVED = {
  results: [{ id: "f1", status: "unresolved", note: "Still off." }],
  newFindings: [],
};
const BACK = {
  file: "src/a.ts",
  line: 9,
  title: "Off by one again",
  evidence: "The bound is < again.",
  suggestion: "Keep <=.",
  recursId: "f0",
};
const REINTRODUCED = {
  results: [{ id: "f1", status: "resolved", note: "" }],
  newFindings: [BACK],
};

// The stop reasons.
const FIXER_BAD_REPLY = "the fixer's reply could not be read";
const REREVIEW_FAILED = "a re-reviewer failed";
const NO_CODE = "the fix left the branch with no code change";
const REINTRODUCED_REASON =
  "a fix reintroduced finding f0; fixes are undoing each other";

/** @param {number} max @returns {string} the generic stop reason for open findings */
function remainReason(max) {
  return `blocking findings remain after ${max} fix rounds`;
}

/**
 * Where locate starts #7 saved at `fix` by the review, with F1 open, a PR
 * and `saved`'s fields.
 * @param {State} [saved]
 * @param {RoleContext} [context]
 * @returns {{ at: ImplState, data: ImplData }}
 */
function fixLocated(saved = {}, context = implContext()) {
  return locate(
    {
      stage: "fix",
      spec: SPEC,
      pr: 42,
      headSha: REVIEWED,
      reviewedSha: REVIEWED,
      findings: [F1],
      nextFindingId: 1,
      resolvedHistory: [],
      round: 0,
      ...saved,
    },
    context,
  );
}

/** @param {Partial<ImplData>} [fields] @returns {ImplData} a fresh fix run's data, with `fields` replacing its own */
function fixData(fields = {}) {
  return { ...fixLocated().data, ...fields };
}

/**
 * The step `result` (with `reply`) takes from `at` in a fix run, with
 * `fields` in data.
 * @param {ImplState} at
 * @param {ImplResult} result
 * @param {unknown} [reply]
 * @param {Partial<ImplData>} [fields]
 * @returns {Step<ImplState, ImplData>}
 */
function fixStepFrom(at, result, reply = null, fields = {}) {
  return transition({ at, data: fixData(fields) }, { name: result, reply });
}

export {
  ACC,
  BACK,
  DIFF_PATH,
  DISPUTE,
  F1,
  FIX_DISPUTES_ACC,
  FIX_DONE,
  FIX_HANDOFF,
  FIXED_HEAD,
  FIXER_BAD_REPLY,
  finding,
  fixData,
  fixLocated,
  fixStepFrom,
  NO_CODE,
  PATCH_ID,
  REINTRODUCED,
  REINTRODUCED_REASON,
  REREVIEW_FAILED,
  RESOLVED,
  REVIEWED,
  remainReason,
  SEC,
  SPEC,
  UNRESOLVED,
};
