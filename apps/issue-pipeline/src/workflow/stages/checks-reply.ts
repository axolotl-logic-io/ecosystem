// The replies sync and checks read: the ops replies of sync-base, finish-sync,
// verify, ci-status, push and prepare-review, and the fixers' and check-fix
// reviewers' structured output. Checked by hand rather than with zod, as in
// src/roles/triage/reply.ts. A reply that doesn't fit reads as a failure.

import type { ListedFinding } from "../types.ts";
import type { ChildResult } from "./types.ts";

type Reply = Readonly<Record<string, unknown>>;

interface Failed {
  kind: "failed";
  // The op's error, or null when it gave none.
  error: string | null;
}

type SyncReply =
  | Failed
  | { kind: "clean"; changed: boolean; headSha: string }
  | {
      kind: "conflict";
      // Whether the rebase was left stopped for a resolver.
      inRebase: boolean;
      conflicts: string[];
      baseSha: unknown;
    };

type FinishReply =
  | Failed
  | { kind: "rejected"; reason: string }
  | { kind: "resolved"; headSha: string };

interface Check {
  id: string;
  pass: boolean;
  detail: string;
  log: string;
  tail: string;
}

type VerifyReply =
  | Failed
  | { kind: "ran"; headSha: string; pass: boolean; checks: Check[] };

type CiReply =
  | Failed
  | { kind: "pass" | "pending" | "no-checks" }
  | { kind: "fail"; failing: string[]; logPath: string }
  // The head moved while CI ran.
  | { kind: "moved"; headSha: string | null };

// A pushed head or a prepared diff.
type Done = Failed | { kind: "done"; value: string };

// A fixer's reply (CIFIX_SCHEMA).
interface FixOutput {
  status: "fixed" | "cannot-fix" | "handoff";
  summary: string;
}

function isRecord(value: unknown): value is Reply {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function failed(reply: Reply): Failed {
  const { error } = reply;
  return { kind: "failed", error: textOf(error) };
}

function syncReplyOf(reply: Reply): SyncReply {
  const { ok, conflict, inRebase, conflicts, baseSha, changed, headSha } =
    reply;
  if (ok !== true) {
    return failed(reply);
  }
  if (conflict === true) {
    let files: string[] = [];
    if (isStrings(conflicts)) {
      files = conflicts;
    }
    return {
      kind: "conflict",
      inRebase: inRebase === true,
      conflicts: files,
      baseSha,
    };
  }
  if (typeof headSha !== "string") {
    return failed(reply);
  }
  return { kind: "clean", changed: changed === true, headSha };
}

function finishReplyOf(reply: Reply): FinishReply {
  const { ok, resolved, headSha, reason } = reply;
  if (ok !== true) {
    return failed(reply);
  }
  if (resolved !== true) {
    return { kind: "rejected", reason: String(reason) };
  }
  if (typeof headSha !== "string") {
    return failed(reply);
  }
  return { kind: "resolved", headSha };
}

// A check of the verify reply; its log and tail are "" when absent.
function checkOf(value: unknown): Check | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, pass, detail, log, tail } = value;
  if (typeof id !== "string" || typeof detail !== "string") {
    return null;
  }
  return {
    id,
    pass: pass === true,
    detail,
    log: textOf(log) ?? "",
    tail: textOf(tail) ?? "",
  };
}

function checksOf(value: unknown): Check[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const checks: Check[] = [];
  for (const entry of value) {
    const check = checkOf(entry);
    if (check === null) {
      return null;
    }
    checks.push(check);
  }
  return checks;
}

function verifyReplyOf(reply: Reply): VerifyReply {
  const { ok, headSha, pass, checks: listed } = reply;
  const checks = checksOf(listed);
  if (ok !== true || typeof headSha !== "string" || checks === null) {
    return failed(reply);
  }
  return { kind: "ran", headSha, pass: pass === true, checks };
}

function ciReplyOf(reply: Reply): CiReply {
  const { ok, status, failing, logPath, headSha } = reply;
  if (ok !== true) {
    return failed(reply);
  }
  if (status === "pass" || status === "pending" || status === "no-checks") {
    return { kind: status };
  }
  if (status !== "fail") {
    return { kind: "moved", headSha: textOf(headSha) };
  }
  if (!isStrings(failing)) {
    return failed(reply);
  }
  return { kind: "fail", failing, logPath: String(logPath) };
}

function doneOf(reply: Reply, value: unknown): Done {
  const { ok } = reply;
  if (ok !== true || typeof value !== "string") {
    return failed(reply);
  }
  return { kind: "done", value };
}

// The head a push left.
function pushedOf(reply: Reply): Done {
  const { headSha } = reply;
  return doneOf(reply, headSha);
}

// The path of a prepared review diff, read as text as the prompt has always
// read it.
function preparedOf(reply: Reply): Done {
  const { diffPath } = reply;
  return doneOf(reply, String(diffPath));
}

// A fixer's reply, or null when it doesn't fit.
function fixOf(output: unknown): FixOutput | null {
  if (!isRecord(output)) {
    return null;
  }
  const { status, summary } = output;
  if (
    (status !== "fixed" && status !== "cannot-fix" && status !== "handoff") ||
    typeof summary !== "string"
  ) {
    return null;
  }
  return { status, summary };
}

// A fixer session's reply, or null when the session failed.
function fixOutputOf(result: ChildResult): FixOutput | null {
  if (!result.ok) {
    return null;
  }
  return fixOf(result.structuredOutput);
}

function isFinding(value: unknown): value is ListedFinding {
  if (!isRecord(value)) {
    return false;
  }
  const { file, line, title, evidence, suggestion } = value;
  return (
    typeof file === "string" &&
    typeof line === "number" &&
    typeof title === "string" &&
    typeof evidence === "string" &&
    typeof suggestion === "string"
  );
}

function isBlocking(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { severity } = value;
  return severity === "blocking";
}

function findingsOf(output: unknown): unknown[] | null {
  if (!isRecord(output)) {
    return null;
  }
  const { findings } = output;
  if (!Array.isArray(findings)) {
    return null;
  }
  return findings;
}

// A check-fix reviewer's blocking findings in its reply (REVIEW_SCHEMA), or
// null when the reply doesn't fit.
function blockingIn(output: unknown): ListedFinding[] | null {
  const findings = findingsOf(output);
  if (findings === null) {
    return null;
  }
  const blocking: ListedFinding[] = [];
  for (const entry of findings) {
    if (!isFinding(entry)) {
      return null;
    }
    if (isBlocking(entry)) {
      blocking.push(entry);
    }
  }
  return blocking;
}

// A check-fix reviewer's blocking findings, or null when its session failed.
function blockingOf(result: ChildResult): ListedFinding[] | null {
  if (!result.ok) {
    return null;
  }
  return blockingIn(result.structuredOutput);
}

export type { Check, FinishReply, FixOutput, SyncReply };
export {
  blockingIn,
  blockingOf,
  checksOf,
  ciReplyOf,
  finishReplyOf,
  fixOf,
  fixOutputOf,
  isRecord,
  isStrings,
  preparedOf,
  pushedOf,
  syncReplyOf,
  verifyReplyOf,
};
