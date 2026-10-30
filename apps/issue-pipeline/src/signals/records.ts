// Accepted-signal records. Each accepted human signal, a control label's
// event or a person's submitted PR review, is one append-only hidden comment
// on its issue, written once by the landing account and never edited. It
// retains its source, the producer's login, durable user id and organization,
// and what it requests: a start's binding read at acceptance, or the review's
// PR, commit and state. So later checks never depend on the label remaining.
// Readers trust only landing-authored, never-edited comments whose author and
// editor come from one verified read. A forged, edited, malformed or
// conflicting record holds, as does a record of an earlier version; an
// incomplete listing is unknown, never "no records". Migration (#249): a
// start record of the retired Author task, whose start label is now
// `start:gherkin` and which a task app runs, is skipped.
import { z } from "zod";
import { currentComments } from "../comment-authority.ts";
import { COMMENT, type IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { wire } from "../discovery/wire.ts";
import {
  HEAD_START_TASKS,
  PR_REVIEW,
  type QualifiedSignal,
  REQUIREMENTS,
  SHA,
  TARGET_STATE,
  type WorkItemRef,
} from "../domain.ts";
import { errorText, type Observation, observeAll } from "./github-source.ts";
import { CONTROL_LABELS, START_LABELS } from "./label-evidence.ts";
import { GITHUB_LOGIN } from "./qualification.ts";

const MARK = "<!-- agent-pipeline:signal\n";
const END = "\n-->";
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
const ISSUE_URL = /\/issues\/(?<number>\d+)$/u;
const POSITIVE = z.number().int().positive();
const RETIRED_START = z.looseObject({
  version: z.literal(2),
  source: z.looseObject({ label: z.literal("start:author") }),
  request: z.looseObject({
    kind: z.literal("start"),
    task: z.literal("author"),
  }),
});
const LABEL_SOURCE = z.strictObject({
  kind: z.literal("github-label"),
  label: z.enum(CONTROL_LABELS),
  event: z.strictObject({
    id: POSITIVE,
    nodeId: z.string().min(1),
    createdAt: z.iso.datetime(),
  }),
});
// A person's submitted review of the issue's linked PR.
const REVIEW_SOURCE = z.strictObject({
  kind: z.literal("github-review"),
  pr: POSITIVE,
  review: z.strictObject({ id: POSITIVE, submittedAt: z.iso.datetime() }),
});
const REQUEST = z.union([
  // Implement for the requirements and target read at acceptance.
  z.strictObject({
    kind: z.literal("start"),
    task: z.literal("implement"),
    requirements: REQUIREMENTS,
    target: TARGET_STATE,
  }),
  // Verify, Fix or Land for the linked PR's head read at acceptance.
  z.strictObject({
    kind: z.literal("start"),
    task: z.enum(HEAD_START_TASKS),
    pr: POSITIVE,
    head: SHA,
    target: TARGET_STATE,
  }),
  z.strictObject({ kind: z.literal("review"), review: PR_REVIEW }),
  z.strictObject({ kind: z.literal("stop") }),
]);

type Source = z.infer<typeof LABEL_SOURCE> | z.infer<typeof REVIEW_SOURCE>;
type Request = z.infer<typeof REQUEST>;

// Whether `request` is the one its source makes: a start label its task, the
// stop label a stop, and a review exactly that review of that PR.
function makes(source: Source, request: Request): boolean {
  if (source.kind === "github-review") {
    return (
      request.kind === "review" &&
      request.review.id === source.review.id &&
      request.review.pr === source.pr
    );
  }
  const task = START_LABELS.get(source.label);
  if (task === undefined) {
    return request.kind === "stop";
  }
  return request.kind === "start" && request.task === task;
}

const RECORD = z
  .strictObject({
    version: z.literal(2),
    kind: z.literal("accepted"),
    id: z.string().min(1),
    workItem: z.strictObject({ repo: z.string().min(1), number: POSITIVE }),
    source: z.discriminatedUnion("kind", [LABEL_SOURCE, REVIEW_SOURCE]),
    producer: z.strictObject({
      route: z.literal("human"),
      login: z.string().regex(GITHUB_LOGIN),
      userId: POSITIVE,
      organization: z.string().regex(GITHUB_LOGIN),
    }),
    request: REQUEST,
    acceptedBy: z.strictObject({ buddyRun: z.uuid() }),
  })
  .refine(
    (record) => makes(record.source, record.request),
    "the request must be the one its source makes",
  );
const MARKED_COMMENT = wire(
  z.looseObject({
    id: POSITIVE,
    issueUrl: z.string(),
    body: z.string().nullish(),
  }),
);

type AcceptedRecord = z.infer<typeof RECORD>;

interface AcceptedRow {
  record: AcceptedRecord;
  recordId: number;
}

// An issue's accepted records from one complete, verified listing. `rows`
// holds every authentic, well-formed record even when `problem` names a rule
// some other comment broke.
type IssueRecords =
  | { status: "ok"; rows: AcceptedRow[]; problem: string | null }
  | { status: "unknown"; reason: string };

// The stable id of the signal a label event produces on a work item.
function signalId(workItem: WorkItemRef, eventId: number): string {
  return `github-label:${workItem.repo}#${workItem.number}:${eventId}`;
}

// The stable id of the signal a submitted PR review produces on a work item.
function reviewSignalId(workItem: WorkItemRef, reviewId: number): string {
  return `github-review:${workItem.repo}#${workItem.number}:${reviewId}`;
}

// The id the signal of `record`'s source must carry.
function sourceId(record: AcceptedRecord): string {
  const { source, workItem } = record;
  if (source.kind === "github-review") {
    return reviewSignalId(workItem, source.review.id);
  }
  return signalId(workItem, source.event.id);
}

// `value` as JSON with every object's keys sorted, for comparing content.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown): unknown => {
    const object = z.record(z.string(), z.unknown()).safeParse(item);
    if (!object.success || Array.isArray(item)) {
      return item;
    }
    return Object.fromEntries(
      Object.entries(object.data).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
}

function recordBody(record: AcceptedRecord): string {
  const json = JSON.stringify(RECORD.parse(record)).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  return `${MARK}${json}${END}`;
}

// The content a duplicate of a record must repeat exactly: everything but
// which buddy run accepted it.
function actionContent(record: AcceptedRecord): string {
  return canonical({
    id: record.id,
    workItem: record.workItem,
    source: record.source,
    producer: record.producer,
    request: record.request,
  });
}

// Whether two records accept the same signal with the same content.
function sameAction(a: AcceptedRecord, b: AcceptedRecord): boolean {
  return actionContent(a) === actionContent(b);
}

// The record in verified comment `item`, or why it can't be trusted.
function rowOf(
  cfg: Config,
  number: number,
  item: IssueComment,
): AcceptedRow | string | null {
  const body = item.body ?? "";
  if (item.lastEditedAt !== null) {
    return `signal record ${item.id} was edited`;
  }
  if (!(body.startsWith(MARK) && body.endsWith(END))) {
    return `signal record ${item.id} is malformed`;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(MARK.length, -END.length));
  } catch {
    return `signal record ${item.id} is unreadable`;
  }
  if (RETIRED_START.safeParse(raw).success) {
    return null;
  }
  const parsed = RECORD.safeParse(raw);
  if (!parsed.success) {
    return `signal record ${item.id} is invalid or of an unknown version`;
  }
  const record = parsed.data;
  if (record.workItem.repo !== cfg.repo || record.workItem.number !== number) {
    return `signal record ${item.id} names another work item`;
  }
  if (record.id !== sourceId(record)) {
    return `signal record ${item.id} carries a mismatched signal id`;
  }
  return { record, recordId: item.id };
}

// `rows` with identical duplicates of one signal merged into the earliest,
// or why two of them conflict.
function merged(rows: readonly AcceptedRow[]): {
  rows: AcceptedRow[];
  problem: string | null;
} {
  const kept = new Map<string, AcceptedRow>();
  let problem: string | null = null;
  for (const row of [...rows].sort((a, b) => a.recordId - b.recordId)) {
    const first = kept.get(row.record.id);
    if (first === undefined) {
      kept.set(row.record.id, row);
    } else if (!sameAction(first.record, row.record)) {
      problem ??= `signal records ${first.recordId} and ${row.recordId} conflict for ${row.record.id}`;
    }
  }
  return { rows: [...kept.values()], problem };
}

// Issue `number`'s accepted records, from every page of its comments with
// each record claim's author, editor and body verified together.
function issueRecords(cfg: Config, number: number): IssueRecords {
  const listed = observeAll(
    cfg,
    `repos/${cfg.repo}/issues/${number}/comments`,
    COMMENT,
  );
  if (listed.status === "absent") {
    return { status: "unknown", reason: `#${number}'s comments are absent` };
  }
  if (listed.status === "unknown") {
    return { status: "unknown", reason: listed.reason };
  }
  const claims = listed.value.filter((item) =>
    (item.body ?? "").startsWith(MARK),
  );
  let nodes: ReturnType<typeof currentComments>;
  try {
    nodes = currentComments(cfg, claims);
  } catch (error) {
    return {
      status: "unknown",
      reason: `signal record provenance unverifiable: ${errorText(error)}`,
    };
  }
  const rows: AcceptedRow[] = [];
  let problem: string | null = null;
  claims.forEach((claim, at) => {
    const node = nodes[at] ?? null;
    if (node === null) {
      problem ??= `comment ${claim.id} by @${claim.user?.login ?? "unknown"} claims to be a signal record`;
      return;
    }
    const row = rowOf(cfg, number, {
      ...claim,
      body: node.body,
      lastEditedAt: node.lastEditedAt,
    });
    if (typeof row === "string") {
      problem ??= row;
    } else if (row !== null) {
      rows.push(row);
    }
  });
  const result = merged(rows);
  return {
    status: "ok",
    rows: result.rows,
    problem: problem ?? result.problem,
  };
}

// The issues that hold a signal record claim, by anyone, found from every
// page of the repository's comments rather than from current labels.
function markedIssues(cfg: Config): Observation<number[]> {
  const listed = observeAll(
    cfg,
    `repos/${cfg.repo}/issues/comments`,
    MARKED_COMMENT,
  );
  if (listed.status !== "ok") {
    return listed;
  }
  const numbers = new Set<number>();
  for (const item of listed.value) {
    if ((item.body ?? "").startsWith(MARK)) {
      const { number } = ISSUE_URL.exec(item.issueUrl)?.groups ?? {};
      if (number === undefined) {
        return {
          status: "unknown",
          reason: `comment ${item.id} names no issue`,
        };
      }
      numbers.add(Number(number));
    }
  }
  return { status: "ok", value: [...numbers] };
}

function signalOf(row: AcceptedRow): QualifiedSignal {
  const { record, recordId } = row;
  const { id, workItem, producer: provenance, request } = record;
  if (request.kind === "stop") {
    return { kind: "stop", id, workItem, provenance, recordId };
  }
  if (request.kind === "review") {
    const { review } = request;
    return { kind: "review", id, workItem, review, provenance, recordId };
  }
  if ("head" in request) {
    const { task, pr, head, target } = request;
    return {
      kind: "start",
      id,
      workItem,
      task,
      pr,
      head,
      target,
      provenance,
      recordId,
    };
  }
  const { task, requirements, target } = request;
  return {
    kind: "start",
    id,
    workItem,
    task,
    requirements,
    target,
    provenance,
    recordId,
  };
}

export type { AcceptedRecord, AcceptedRow, IssueRecords };
export {
  canonical,
  issueRecords,
  markedIssues,
  RECORD,
  recordBody,
  reviewSignalId,
  sameAction,
  signalId,
  signalOf,
};
