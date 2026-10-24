// The task-result record (#183; docs/reference/task-results.md): its
// binding, attempt and result schemas, its comment body, and which comments
// hold one. Each attempt and each result is its own append-only hidden comment
// that only the landing account writes: version 1 of a new record, so saved
// state keeps its version and bytes and a stale state save can't reach it.

import { z } from "zod";
import { assertCommentAuthority } from "./comment-authority.ts";
import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { OpsError } from "./ops-error.ts";

const MARK = "<!-- agent-pipeline:task-result\n";
const END = "\n-->";
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
const MAX_SUMMARY = 300;
// Each task's attempts per binding (`runs-and-retries` rule 5).
const TASK_ATTEMPTS = 3;

const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/u);
const RUN_ID = z.string().uuid();
const TARGET = z.strictObject({ branch: z.string().min(1), commit: SHA });
const PLACE = {
  repo: z.string().min(1),
  workItem: z.number().int().positive(),
};
// Tasks that check or change a revision bind it; Author and the first
// Implementation run before one exists and bind the requirements instead
// (`requirements-bindings`).
const BINDING = z.union([
  z.strictObject({
    ...PLACE,
    task: z.enum([
      "Implementation",
      "Hardening",
      "Sync",
      "Integration",
      "Security",
      "Land",
      "Completion",
    ]),
    revision: z.strictObject({ code: SHA, inputs: DIGEST, policy: DIGEST }),
    target: TARGET,
  }),
  z.strictObject({
    ...PLACE,
    task: z.enum(["Author", "Implementation"]),
    requirements: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    target: TARGET,
  }),
]);
const VERDICT = z.enum(["passed", "failed", "refused", "unknown"]);
const RECEIPT = z.strictObject({
  summary: z.string().min(1).max(MAX_SUMMARY),
  // The revision a writer task such as Sync produced.
  produced: z.strictObject({ code: SHA }).optional(),
  evidence: z.json().optional(),
});
const ATTEMPT = z.strictObject({
  version: z.literal(1),
  kind: z.literal("attempt"),
  binding: BINDING,
  run: z.strictObject({ id: RUN_ID, previous: RUN_ID.nullable() }),
});
const RESULT = z.strictObject({
  version: z.literal(1),
  kind: z.literal("result"),
  binding: BINDING,
  run: z.strictObject({ id: RUN_ID }),
  verdict: VERDICT,
  receipt: RECEIPT,
});
const RECORD = z.discriminatedUnion("kind", [ATTEMPT, RESULT]);

type Binding = z.infer<typeof BINDING>;
type Attempt = z.infer<typeof ATTEMPT>;
type Result = z.infer<typeof RESULT>;
type TaskRecord = z.infer<typeof RECORD>;
type Row<T extends TaskRecord = TaskRecord> = T & { id: number };

type TaskStatus =
  | { status: "passed" | "refused"; result: Result; attempts: number }
  | { status: "unknown"; run: string; attempts: number }
  | { status: "missing" | "exhausted"; attempts: number; budget: number }
  | { status: "held"; reason: string };

// Records the reader can't trust as read: stop for reconciliation.
class TaskResultsHold extends OpsError {}

function hold(reason: string): never {
  throw new TaskResultsHold(`task results require reconciliation: ${reason}`);
}

// Every part of a binding, in a fixed order, so equal bindings compare equal
// whatever their key order. An absent part is distinct from every value.
function bindingKey(binding: Binding): string {
  let subject = ["requirements"];
  if ("revision" in binding) {
    const { code, inputs, policy } = binding.revision;
    subject = ["revision", code, inputs, policy];
  } else {
    subject.push(binding.requirements);
  }
  return JSON.stringify([
    binding.repo,
    binding.workItem,
    binding.task,
    ...subject,
    binding.target.branch,
    binding.target.commit,
  ]);
}

function sameBinding(a: Binding, b: Binding): boolean {
  return bindingKey(a) === bindingKey(b);
}

// The binding a request names, if it is this issue's on the configured target.
function requestedBinding(
  cfg: Pick<Config, "repo" | "baseBranch">,
  number: number,
  binding: Binding,
): Binding {
  if (
    binding.repo !== cfg.repo ||
    binding.workItem !== number ||
    binding.target.branch !== cfg.baseBranch
  ) {
    throw new OpsError(
      `the binding is not #${number}'s in ${cfg.repo} on ${cfg.baseBranch}`,
    );
  }
  return binding;
}

function recordBody(record: TaskRecord): string {
  const json = JSON.stringify(RECORD.parse(record)).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  return `${MARK}${json}${END}`;
}

// The record in `comment`, if it holds one. A body that starts with the mark
// is a record claim: anyone but the landing account writing it holds.
function rowOf(
  cfg: Pick<Config, "repo" | "mergeAccount">,
  number: number,
  comment: IssueComment,
): Row[] {
  const body = comment.body ?? "";
  if (!body.startsWith(MARK)) {
    return [];
  }
  try {
    assertCommentAuthority(cfg, comment);
  } catch {
    hold(`comment ${comment.id} is not the landing account's own record`);
  }
  if (!body.endsWith(END)) {
    hold(`comment ${comment.id} is a malformed record`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(MARK.length, -END.length));
  } catch {
    hold(`comment ${comment.id} is an unreadable record`);
  }
  const parsed = RECORD.safeParse(raw);
  if (!parsed.success) {
    hold(`comment ${comment.id} is an invalid record`);
  }
  const { binding } = parsed.data;
  if (binding.repo !== cfg.repo || binding.workItem !== number) {
    hold(`comment ${comment.id} is bound to another work item`);
  }
  return [{ ...parsed.data, id: comment.id }];
}

function isAttempt(row: Row): row is Row<Attempt> {
  return row.kind === "attempt";
}

function isResult(row: Row): row is Row<Result> {
  return row.kind === "result";
}

export type { Attempt, Binding, Result, Row, TaskRecord, TaskStatus };
export {
  ATTEMPT,
  BINDING,
  bindingKey,
  hold,
  isAttempt,
  isResult,
  RECEIPT,
  RECORD,
  RESULT,
  RUN_ID,
  recordBody,
  requestedBinding,
  rowOf,
  sameBinding,
  TASK_ATTEMPTS,
  TaskResultsHold,
  VERDICT,
};
