// An issue's state, which saved-state.ts keeps on GitHub. This module owns
// the state's schema (version 2), its log, and the approval rule that an approval holds only
// for the exact revision the reviewer saw (`approval-is-for-one-revision`).

import { z } from "zod";
import type { Status } from "./stages.ts";
import { STAGES } from "./stages.ts";

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

const FLOWS = z.object({ code: z.boolean(), wiki: z.boolean() });

// What a review or a merge saw: the code head, the wiki head (null when the
// issue has no wiki commits) and the trusted-inputs revision.
const REVISION = z.object({
  code: z.string().nullable(),
  wiki: z.string().nullable(),
  inputs: z.string(),
});

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

const MERGE_RETURN = z.object({
  reason: z.enum(["conflict", "retest", "ci", "wiki-check", "wiki-conflict"]),
  detail: z.string(),
  codeMerged: z.boolean(),
});

// The issue's PR as GitHub says it merged: its number and the merge
// commit's oid. Only the claim sets it, from GitHub, never from a legacy
// state or a reply; set, the code is in the base and only wiki work remains.
const CODE_MERGED = z.object({
  pr: z.number().int().positive(),
  sha: z.string().min(1),
});

// The trusted-inputs revision the author's questions were asked at: the
// issue waits at needs-info while its inputs still hash to it. The job's ask
// end sets it and the author's Gherkin clears it.
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
  // The last code head the pipeline pushed, which adopt-push moves on.
  headSha: z.string().nullable().catch(null),
  flows: FLOWS.nullable().catch(null),
  gherkin: GHERKIN_REF.nullable().catch(null),
  review: REVIEW.catch(EMPTY_REVIEW),
  // The code head whose verification last passed.
  verifiedSha: z.string().nullable().catch(null),
  mergeReturn: MERGE_RETURN.nullable().catch(null),
  // The revision the merge job merged and published.
  merged: REVISION.nullable().catch(null),
  codeMerged: CODE_MERGED.nullable().catch(null),
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

function newIssueState(number: number): IssueState {
  return {
    version: 2,
    number,
    stage: "author",
    stoppedStage: null,
    stopCode: null,
    resumeStage: null,
    lease: null,
    pr: null,
    headSha: null,
    flows: null,
    gherkin: null,
    review: { ...EMPTY_REVIEW, findings: [] },
    verifiedSha: null,
    mergeReturn: null,
    merged: null,
    codeMerged: null,
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
  return a.code === b.code && a.wiki === b.wiki && a.inputs === b.inputs;
}

// Whether the issue's approval holds for `current`: the last review approved
// exactly this code head, wiki head and inputs revision. Any change after the
// review, a clean rebase included, voids it.
function approvalHolds(state: IssueState, current: Revision): boolean {
  const { verdict, revision } = state.review;
  return (
    verdict === "approve" &&
    revision !== null &&
    sameRevision(revision, current)
  );
}

function isStatus(value: unknown): value is Status {
  return STATUS.safeParse(value).success;
}

export type { Asked, CodeMerged, Finding, IssueState, MergeReturn, Revision };
export {
  approvalHolds,
  clippedLog,
  FINDING,
  FLOWS,
  ISSUE_STATE,
  isStatus,
  LEASE,
  newIssueState,
  resumeOf,
  withLog,
};
