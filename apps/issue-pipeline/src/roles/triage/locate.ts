// Where a triage run starts, and what it carries: the issue's hand-off fields
// and event log read from its saved state, this run counted, and the session
// to run or the stop that keeps it from running. Every start runs triage again from its first step, so a restart
// repeats the session rather than resuming it (`every-role-resumes`). Pure.

import type { State } from "../../state.ts";
import type { Signature } from "../../workflow/signing.ts";
import { isStrings } from "../../workflow/stages/reply-guards.ts";
import type { MachineState, SessionEffect } from "../machine.ts";
import type { RoleContext } from "../walk.ts";
import type { TriageDecision, TriageReply } from "./reply.ts";
import { limitReason, triageSession } from "./task.ts";

// The issue's event log, as noteEvent keeps it.
interface TriageLog {
  log?: string[];
}

// Why a run stops before its session: past `maxTriages`. `code` is the stop
// code (src/stops.ts).
interface TriageStop {
  code: string;
  reason: string;
  detail: string | null;
}

// What the run does first: the session, or a stop.
type TriageStart =
  | { kind: "session"; session: SessionEffect }
  | { kind: "stop"; stop: TriageStop };

// The session's reply as the run read it: not yet, unreadable, or decided.
type TriageReading =
  | { kind: "pending" }
  | { kind: "unreadable" }
  | { kind: "decided"; decision: TriageDecision; reply: TriageReply };

interface TriageData extends TriageLog {
  issue: number;
  // 0 for an issue, 1 for a sub-issue.
  depth: number;
  // When the run started, which stamps its event-log lines.
  at: Date;
  // Who signs the run's comments.
  by: Signature;
  start: TriageStart;
  reading: TriageReading;
  // How many times triage has run on the issue, this run included.
  triages: number;
  plan: string | undefined;
  splitSuggested: string | null | undefined;
  pr: number | null | undefined;
  headSha: string | null | undefined;
  implemented: boolean | undefined;
}

// Counts this run on a copy of `st`, and gives the stop that keeps the
// session from running, or null when it may run.
function startTriage<T extends { triages?: number }>(
  st: T,
  maxTriages: number,
): { counted: T & { triages: number }; stop: TriageStop | null } {
  const counted = { ...st, triages: (st.triages ?? 0) + 1 };
  if (counted.triages > maxTriages) {
    const reason = limitReason(maxTriages);
    return { counted, stop: { code: "triage-limit", reason, detail: null } };
  }
  return { counted, stop: null };
}

function numberOr<T>(value: unknown, fallback: T): number | T {
  if (typeof value === "number") {
    return value;
  }
  return fallback;
}

function textOr<T>(value: unknown, fallback: T): string | T {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function nullOr(value: unknown): null | undefined {
  if (value === null) {
    return null;
  }
  return undefined;
}

// The saved state's run count and event log; a malformed field reads as
// missing.
function countedOf(saved: State): TriageLog & { triages: number } {
  const { log, triages } = saved;
  const counted: TriageLog & { triages: number } = {
    triages: numberOr(triages, 0),
  };
  if (isStrings(log)) {
    counted.log = log;
  }
  return counted;
}

type TriageHandoff = Pick<
  TriageData,
  "plan" | "splitSuggested" | "pr" | "headSha" | "implemented"
>;

// The saved hand-off fields; a malformed field reads as missing.
function handoffOf(saved: State): TriageHandoff {
  const { plan, splitSuggested, pr, headSha, implemented } = saved;
  let done: boolean | undefined;
  if (typeof implemented === "boolean") {
    done = implemented;
  }
  return {
    plan: textOr(plan, undefined),
    splitSuggested: textOr(splitSuggested, nullOr(splitSuggested)),
    pr: numberOr(pr, nullOr(pr)),
    headSha: textOr(headSha, nullOr(headSha)),
    implemented: done,
  };
}

// Starts every run at the triage step, with this run counted.
function locate(
  saved: State,
  context: RoleContext,
): MachineState<string, TriageData> {
  const { issue, cfg, budgets, models, paths, now } = context;
  const depth = numberOr(saved.depth, 0);
  const { counted, stop } = startTriage(countedOf(saved), cfg.maxTriages);
  const session = triageSession(
    { n: issue, paths, depth, attempt: counted.triages },
    { cfg, budgets, models },
  );
  let start: TriageStart = { kind: "session", session };
  if (stop !== null) {
    start = { kind: "stop", stop };
  }
  const { agent, model } = session;
  const by: Signature = { role: "triage", agent, model, run: null };
  const data: TriageData = {
    ...counted,
    ...handoffOf(saved),
    issue,
    depth,
    at: now,
    by,
    start,
    reading: { kind: "pending" },
  };
  return { at: "triage", data };
}

export type { TriageData, TriageReading, TriageStop };
export { locate, startTriage };
