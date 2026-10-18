// An issue's saved state: one hidden comment per issue that only the
// pipeline's account writes. GitHub is the source of truth; this module owns
// the state's schema (version 2), reading a state the installed version saved
// (version 1) as version 2, and the approval rule that an approval holds only
// for the exact revision the reviewer saw (`approval-is-for-one-revision`).

import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import { listComments, rawComment, STATE_MARK } from "./comments.ts";
import type { Config } from "./config.ts";
import { gh } from "./github.ts";
import { OpsError } from "./process.ts";
import type { Stage, Status } from "./stages.ts";
import { STAGES } from "./stages.ts";

const MARK_END = "-->";
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
// Leaves room under GitHub's comment limit for the header and footer.
const MAX_STATE_LENGTH = 60_000;
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

interface StoredState {
  id: number | null;
  state: IssueState | null;
}

// The installed version's (version 1) fields the migration reads; it drops
// every other field.
const LEGACY_STATE = z.looseObject({
  stage: z.string().optional().catch(undefined),
  stoppedStage: z.string().nullish().catch(null),
  stopCode: z.string().nullish().catch(null),
  lease: LEASE.nullish().catch(null),
  pr: z.number().int().positive().nullish().catch(null),
  headSha: z.string().nullish().catch(null),
  flows: FLOWS.nullish().catch(null),
  log: z.array(z.unknown()).nullish().catch(null),
});

// Legacy stages before any code work, which go to the author alone.
const LEGACY_AUTHOR_STAGES: ReadonlySet<string> = new Set(["triage", "spec"]);

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

// Where a legacy stage resumes after the author writes the Gherkin: null for
// the stages before code work; review for a merged issue whose wiki is
// unpublished (the reviewer sees the wiki before it is published); implement
// for every other stage, so the job verifies the branch afresh.
function legacyResumeStage(stage: string | undefined): Stage | null {
  if (stage === undefined || LEGACY_AUTHOR_STAGES.has(stage)) {
    return null;
  }
  if (stage === "publish") {
    return "review";
  }
  return "implement";
}

// A version 1 state read as version 2. Every legacy issue goes to the author
// first, since no Gherkin exists yet; it keeps its PR, head, lease and flows.
function migrateLegacyState(raw: unknown, number: number): IssueState {
  const legacy = LEGACY_STATE.safeParse(raw).data ?? {};
  const base = newIssueState(number);
  const kept: IssueState = {
    ...base,
    lease: legacy.lease ?? null,
    pr: legacy.pr ?? null,
    headSha: legacy.headSha ?? null,
    flows: legacy.flows ?? null,
    log: clippedLog(
      (legacy.log ?? []).filter((entry) => typeof entry === "string"),
    ),
  };
  const { stage } = legacy;
  if (stage === "done") {
    return { ...kept, stage: "done" };
  }
  if (stage === "stopped") {
    return {
      ...kept,
      stage: "stopped",
      stoppedStage: "author",
      stopCode: legacy.stopCode ?? null,
      resumeStage: legacyResumeStage(legacy.stoppedStage ?? undefined),
    };
  }
  return { ...kept, resumeStage: legacyResumeStage(stage) };
}

// The saved state in `raw`: version 2 as saved, an older version migrated,
// or null when it can't be read.
function parseIssueState(raw: unknown, number: number): IssueState | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  if ("version" in raw && raw.version === 2) {
    return ISSUE_STATE.safeParse(raw).data ?? null;
  }
  const migrated = migrateLegacyState(raw, number);
  const legacy = LEGACY_STATE.safeParse(raw).data;
  return withLog(
    migrated,
    `migrated from the installed version's state at ${legacy?.stage ?? "no stage"}`,
    new Date(),
  );
}

// The state in a state comment's body, or null when it has none or it is
// unreadable.
function parseStateBody(body: string, number: number): IssueState | null {
  const start = body.indexOf(STATE_MARK);
  const end = body.indexOf(MARK_END, start);
  if (start < 0 || end < 0) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(body.slice(start + STATE_MARK.length, end));
    return parseIssueState(raw, number);
  } catch {
    return null;
  }
}

function readState(
  cfg: Config,
  number: number,
  comments?: readonly IssueComment[],
): StoredState {
  // Only trust a state comment written by the pipeline's account. Anyone can
  // paste the marker.
  const mine = (comments ?? listComments(cfg, number)).filter(
    (item) =>
      item.user?.login === cfg.account &&
      (item.body ?? "").includes(STATE_MARK),
  );
  const latest = mine.at(-1);
  if (latest === undefined) {
    return { id: null, state: null };
  }
  return { id: latest.id, state: parseStateBody(latest.body ?? "", number) };
}

function stateBody(number: number, state: IssueState): string {
  const json = JSON.stringify(ISSUE_STATE.parse(state)).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  return `**🤖 issue-pipeline · state**\n${STATE_MARK}\n${json}\n-->\n<sub>Machine state for #${number}. The pipeline rewrites this comment; do not edit it.</sub>`;
}

function writeState(cfg: Config, number: number, state: IssueState): void {
  const body = stateBody(number, state);
  if (body.length > MAX_STATE_LENGTH) {
    throw new OpsError(
      `state for #${number} is too large (${body.length} chars)`,
    );
  }
  const { id } = readState(cfg, number);
  if (id === null) {
    rawComment(cfg, number, body);
    return;
  }
  gh(cfg, [
    "api",
    "-X",
    "PATCH",
    `repos/${cfg.repo}/issues/comments/${id}`,
    "-f",
    `body=${body}`,
    "--silent",
  ]);
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

export type {
  Asked,
  CodeMerged,
  Finding,
  IssueState,
  MergeReturn,
  Revision,
  StoredState,
};
export {
  approvalHolds,
  FINDING,
  ISSUE_STATE,
  isStatus,
  migrateLegacyState,
  newIssueState,
  parseIssueState,
  parseStateBody,
  readState,
  resumeOf,
  stateBody,
  withLog,
  writeState,
};
