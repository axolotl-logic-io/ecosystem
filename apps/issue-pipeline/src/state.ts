// An issue's state, which saved-state.ts keeps on GitHub. This module owns
// the state's schema (version 2), its log, and the merge authorization rule:
// only the exact code/input revision that passed hardening. Security must
// clear that candidate before merge; old merged-result receipts are history.

import { z } from "zod";
import { EXECUTION_RECEIPT } from "./execution-receipt.ts";
import {
  INTEGRATION,
  legacyWikiOf,
  MERGE_ATTEMPT,
  REVISION,
} from "./merge-provenance.ts";
import { REVIEWED_TARGET } from "./reviewed-target.ts";
import type { Status } from "./stages.ts";
import { STAGES } from "./stages.ts";
import {
  SECURITY,
  type SECURITY_CATEGORY,
  SECURITY_VERDICT,
} from "./state-security.ts";

const MAX_LOG_ENTRIES = 40;
const MAX_LOG_ENTRY = 300;
const STAMP_LENGTH = 16;
const STAGE = z.enum(STAGES);
const STATUS = z.enum([...STAGES, "stopped", "done"]);

const LEASE = z.object({
  lane: z.string().nullish(),
  sweepId: z.string().nullish(),
  at: z.string(),
});

// Whether the issue's change has code. A state saved while the pipeline had
// a wiki also has a legacy `wiki` flag, which nothing reads: parsing drops it.
const FLOWS = z.object({ code: z.boolean() });

const FINDING = z.object({
  id: z.number().int().positive(),
  severity: z.enum(["blocking", "note"]),
  text: z.string(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
});

// A cache of the Gherkin comment's own mark (comments.ts reads the comment).
const GHERKIN_REF = z.object({
  commentId: z.number().int().positive(),
  rev: z.number().int().positive(),
  inputs: z.string(),
});

const EMPTY_REVIEW = {
  round: 0,
  verdict: null,
  commentId: null,
  findings: [],
  revision: null,
};

const REVIEW = z.object({
  // Review rounds that sent the issue back to implement.
  round: z.number().int().nonnegative().catch(0),
  verdict: z.enum(["approve", "changes"]).nullable().catch(null),
  // The PR comment holding the last review.
  commentId: z.number().int().positive().nullable().catch(null),
  findings: z.array(FINDING).catch([]),
  // The revision the last review saw.
  revision: REVISION.nullable().catch(null),
});

// The reasons "wiki-check" and "wiki-conflict" are legacy: no longer written.
const MERGE_RETURN = z.object({
  reason: z.enum(["conflict", "retest", "ci", "wiki-check", "wiki-conflict"]),
  detail: z.string(),
  codeMerged: z.boolean(),
});

// Genuine GitHub merged truth, not own provenance or completion authority.
const CODE_MERGED = z.object({
  pr: z.number().int().positive(),
  sha: z.string().min(1),
});

// Questions wait at needs-info until trusted inputs change.
const ASKED = z.object({ inputs: z.string().min(1) });

const ZERO_COUNTS = { conflictFixes: 0, syncs: 0 };

const COUNTS = z.object({
  conflictFixes: z.number().int().nonnegative().catch(0),
  syncs: z.number().int().nonnegative().catch(0),
});

// A malformed optional field reads as its empty value, so one bad field never
// loses the issue's PR or branch head; only an unreadable stage or number
// makes the whole state unreadable.
const ISSUE_STATE = z.object({
  version: z.literal(2),
  execution: EXECUTION_RECEIPT.optional(),
  number: z.number().int().positive(),
  stage: STATUS,
  // The stage a stop happened in; lifting the stop resumes there.
  stoppedStage: STAGE.nullable().catch(null),
  stopCode: z.string().nullable().catch(null),
  // The stage to return to after the author, when new trusted input sent an
  // issue back to it, or a legacy issue migrated to it.
  resumeStage: STAGE.nullable().catch(null),
  lease: LEASE.nullable().catch(null),
  pr: z.number().int().positive().nullable().catch(null),
  // The branch the issue is bound to (branch-binding.ts); null in a state
  // saved before assignments, whose work is on agent/issue-<n>.
  branch: z.string().min(1).nullable().catch(null),
  // The last code head the pipeline pushed, which adopt-push moves on.
  headSha: z.string().nullable().catch(null),
  flows: FLOWS.nullable().catch(null),
  gherkin: GHERKIN_REF.nullable().catch(null),
  // Missing means saved work from the mandatory-Author runtime.
  authorUsed: z.boolean().default(true).catch(true),
  requirementsInputs: z.string().min(1).nullable().default(null).catch(null),
  review: REVIEW.catch(EMPTY_REVIEW),
  // The exact revision that passed the Reviewer's hardening, which
  // authorizes its merge; any other revision is hardened first.
  hardened: REVISION.nullable().catch(null),
  hardenedTarget: REVIEWED_TARGET.nullable().catch(null),
  // The receipt of the Reviewer's own integration of the hardened revision.
  integration: INTEGRATION.nullable().catch(null),
  // Exact Security clearance/rejection (security-clearance.ts).
  security: SECURITY.nullable().catch(null),
  // A read-only current-policy result observation preserves candidate history.
  resultSecurity: SECURITY_VERDICT.strict()
    .extend({
      revision: REVISION.extend({ policy: REVISION.shape.policy.unwrap() }),
      target: REVIEWED_TARGET,
    })
    .nullable()
    .optional(),
  verifiedSha: z.string().nullable().catch(null),
  mergeReturn: MERGE_RETURN.nullable().catch(null),
  merged: REVISION.nullable().catch(null),
  codeMerged: CODE_MERGED.nullable().catch(null),
  mergeAttempt: MERGE_ATTEMPT.nullable().catch(null),
  asked: ASKED.nullable().catch(null),
  counts: COUNTS.catch(ZERO_COUNTS),
  log: z.array(z.string()).catch([]),
});

type IssueState = z.infer<typeof ISSUE_STATE>;
type Revision = z.infer<typeof REVISION>;
type Finding = z.infer<typeof FINDING>;
type MergeReturn = z.infer<typeof MERGE_RETURN>;
type CodeMerged = z.infer<typeof CODE_MERGED>;
type Asked = z.infer<typeof ASKED>;
type Integration = z.infer<typeof INTEGRATION>;
type Security = z.infer<typeof SECURITY>;
type SecurityCategory = z.infer<typeof SECURITY_CATEGORY>;

function stamp(now: Date): string {
  return `${now.toISOString().slice(0, STAMP_LENGTH)}Z`;
}

function clippedLog(entries: readonly string[]): string[] {
  return entries
    .slice(-MAX_LOG_ENTRIES)
    .map((entry) => entry.slice(0, MAX_LOG_ENTRY));
}

// A state with `entry` appended to its log, keeping the log short.
function withLog(state: IssueState, entry: string, now: Date): IssueState {
  return {
    ...state,
    log: clippedLog([...state.log, `${stamp(now)} ${entry}`]),
  };
}

function newIssueState(
  number: number,
  stage: "author" | "implement" = "implement",
): IssueState {
  return {
    version: 2,
    number,
    stage,
    stoppedStage: null,
    stopCode: null,
    resumeStage: null,
    lease: null,
    pr: null,
    branch: null,
    headSha: null,
    flows: null,
    gherkin: null,
    authorUsed: stage === "author",
    requirementsInputs: null,
    review: { ...EMPTY_REVIEW, findings: [] },
    hardened: null,
    hardenedTarget: null,
    integration: null,
    security: null,
    verifiedSha: null,
    mergeReturn: null,
    merged: null,
    codeMerged: null,
    mergeAttempt: null,
    asked: null,
    counts: { ...ZERO_COUNTS },
    log: [],
  };
}

// A stopped issue with its stop lifted: back at the stage that stopped, with
// the round counts that bound its loops reset (`every-role-resumes`).
function resumeOf(state: IssueState): IssueState {
  if (state.stage !== "stopped") {
    return state;
  }
  return {
    ...state,
    stage: state.stoppedStage ?? "author",
    stoppedStage: null,
    stopCode: null,
    review: { ...state.review, round: 0 },
    counts: { ...ZERO_COUNTS },
  };
}

function sameRevision(a: Revision, b: Revision): boolean {
  return (
    a.code === b.code &&
    legacyWikiOf(a) === legacyWikiOf(b) &&
    a.inputs === b.inputs &&
    (a.policy ?? null) === (b.policy ?? null)
  );
}

// Only exact hardening authorizes a candidate. Integration receipts remain
// recovery evidence, never an exception for changed code.
function mergeAuthorization(state: IssueState): Revision | null {
  return state.hardened;
}

function approvalHolds(state: IssueState, current: Revision): boolean {
  const authorized = mergeAuthorization(state);
  return authorized !== null && sameRevision(authorized, current);
}

function isStatus(value: unknown): value is Status {
  return STATUS.safeParse(value).success;
}

export type { MergeAttempt } from "./merge-provenance.ts";
export type {
  Asked,
  CodeMerged,
  Finding,
  Integration,
  IssueState,
  MergeReturn,
  Revision,
  Security,
  SecurityCategory,
};
export {
  approvalHolds,
  clippedLog,
  FINDING,
  FLOWS,
  ISSUE_STATE,
  isStatus,
  LEASE,
  mergeAuthorization,
  newIssueState,
  resumeOf,
  sameRevision,
  withLog,
};
