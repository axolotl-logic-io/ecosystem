// How a sweep judges one open issue: skip it, count it as skipped with a
// reason, reserve it as a split parent, leave it waiting on an earlier
// sub-issue or on another live lane, or offer it as a candidate to claim.

import { z } from "zod";
import type { LaneRequest } from "../claims.ts";
import { leaseLane } from "../claims.ts";
import type { IssueComment } from "../comments.ts";
import {
  AFTER_MARK,
  listComments,
  PARENT_MARK,
  pipelineRole,
} from "../comments.ts";
import type { Config } from "../config.ts";
import { isAllowedUser } from "../github.ts";
import { isPipelineLabel, LABELS } from "../labels.ts";
import type { State } from "../state.ts";
import { readState } from "../state.ts";
import { isStopLabel } from "../stops.ts";

// A row of `gh issue list`.
const ISSUE_ROW = z.looseObject({
  author: z.looseObject({ login: z.string().nullish() }).nullish(),
  body: z.string().nullish(),
  createdAt: z.string(),
  labels: z.array(z.looseObject({ name: z.string() })),
  number: z.number(),
  title: z.string(),
});

const LEASE = z.looseObject({
  at: z.string().nullish(),
  lane: z.unknown().optional(),
  sweepId: z.unknown().optional(),
});
const QUESTIONS_AT = z.string().nullish();

type IssueRow = z.infer<typeof ISSUE_ROW>;
type Kind = "mine" | "resume" | "answered" | "new" | "named";

// A lane's own live issue first, then lapsed leases, answered questions and
// new work.
const PRIORITY: Readonly<Record<Kind, number>> = {
  mine: -1,
  resume: 0,
  answered: 1,
  new: 2,
  named: 0,
};

interface Candidate {
  number: number;
  title: string;
  kind: Kind;
  priority: number;
  createdAt: string;
  depth: number;
}

// What a sweep does with one open issue.
type Verdict =
  | { kind: "skip" }
  | { kind: "skipped"; reason: string }
  | { kind: "parent" }
  | { kind: "waiting-on-after" }
  | { kind: "live-elsewhere" }
  | { kind: "candidate"; candidate: Candidate };

// What a sweep knows while it judges its issues.
interface SweepContext {
  cfg: Config;
  // This sweep's lane.
  lane: string;
  // Issues with any of these labels are skipped (config skipLabels).
  skipLabels: readonly string[];
  // false: no new issues are taken (config takeNewWork).
  takeNewWork: boolean;
  openNumbers: ReadonlySet<number>;
  now: number;
  leaseMs: number;
}

// The issue's depth below its split parents, from its parent mark.
function issueDepth(body: string | null | undefined): number {
  const { depth } = PARENT_MARK.exec(body ?? "")?.groups ?? {};
  if (depth === undefined) {
    return 0;
  }
  return Number(depth);
}

// The issue's lease, when a lane renewed it within leaseHours.
function liveLease(
  state: State | null,
  now: number,
  leaseMs: number,
): LaneRequest | null {
  const { lease } = state ?? {};
  const parsed = LEASE.nullish().safeParse(lease);
  const at = parsed.data?.at;
  if (!parsed.success || at === undefined || at === null || at === "") {
    return null;
  }
  if (now - Date.parse(at) < leaseMs) {
    return parsed.data ?? null;
  }
  return null;
}

// True when an allowed user commented after the pipeline asked its questions
// (the saved state's questionsAt). It judges by the signature, not the
// author: the pipeline's account may be the person answering.
function answeredSince(
  cfg: Config,
  comments: readonly IssueComment[],
  state: State | null,
): boolean {
  const { questionsAt } = state ?? {};
  const asked = QUESTIONS_AT.safeParse(questionsAt).data;
  let askedAt = 0;
  if (asked !== undefined && asked !== null && asked !== "") {
    askedAt = Date.parse(asked);
  }
  return comments.some(
    (item) =>
      pipelineRole(cfg, item) === null &&
      Date.parse(item.created_at) > askedAt &&
      isAllowedUser(cfg, item.user?.login),
  );
}

// True when the issue's questions have an answer, read from GitHub.
function answered(cfg: Config, n: number): boolean {
  const comments = listComments(cfg, n);
  const { state } = readState(cfg, n, comments);
  return answeredSince(cfg, comments, state);
}

function candidate(issue: IssueRow, kind: Kind): Verdict {
  return {
    kind: "candidate",
    candidate: {
      number: issue.number,
      title: issue.title,
      kind,
      priority: PRIORITY[kind],
      createdAt: issue.createdAt,
      depth: issueDepth(issue.body),
    },
  };
}

// An issue the pipeline is working on, has asked about, or hasn't touched.
function classifyWork(
  ctx: SweepContext,
  issue: IssueRow,
  labels: ReadonlySet<string>,
): Verdict {
  const { cfg } = ctx;
  if (labels.has(LABELS.working.name)) {
    const { state } = readState(cfg, issue.number);
    const lease = liveLease(state, ctx.now, ctx.leaseMs);
    if (lease === null) {
      return candidate(issue, "resume");
    }
    if (leaseLane(lease) !== ctx.lane) {
      return { kind: "live-elsewhere" };
    }
    // A lane finishes its own issue before it takes another.
    return candidate(issue, "mine");
  }
  if (labels.has(LABELS.needsInfo.name)) {
    if (answered(cfg, issue.number)) {
      return candidate(issue, "answered");
    }
    return { kind: "skip" };
  }
  if ([...labels].some(isPipelineLabel)) {
    return { kind: "skip" };
  }
  if (!ctx.takeNewWork) {
    return {
      kind: "skipped",
      reason: "new work is paused (takeNewWork: false)",
    };
  }
  return candidate(issue, "new");
}

// True when an earlier sub-issue the issue waits on is still open.
function waitsOnAfter(ctx: SweepContext, issue: IssueRow): boolean {
  const { after } = AFTER_MARK.exec(issue.body ?? "")?.groups ?? {};
  return (after ?? "")
    .split(",")
    .some((dep) => dep !== "" && ctx.openNumbers.has(Number(dep)));
}

function classify(ctx: SweepContext, issue: IssueRow): Verdict {
  const labels = new Set(issue.labels.map((label) => label.name));
  if ([...labels].some(isStopLabel) || labels.has(LABELS.merged.name)) {
    return { kind: "skip" };
  }
  const skipLabel = ctx.skipLabels.find((label) => labels.has(label));
  if (skipLabel !== undefined) {
    return { kind: "skipped", reason: `labelled ${skipLabel} (skipLabels)` };
  }
  // The pipeline's account is always allowed, so its sub-issues pass too.
  if (!isAllowedUser(ctx.cfg, issue.author?.login)) {
    return {
      kind: "skipped",
      reason: "author is not on allowedUsers, or not a collaborator",
    };
  }
  if (labels.has(LABELS.split.name)) {
    return { kind: "parent" };
  }
  if (waitsOnAfter(ctx, issue)) {
    return { kind: "waiting-on-after" };
  }
  return classifyWork(ctx, issue, labels);
}

export type { Candidate, IssueRow, Kind, SweepContext, Verdict };
export { answeredSince, classify, ISSUE_ROW, issueDepth, liveLease, PRIORITY };
