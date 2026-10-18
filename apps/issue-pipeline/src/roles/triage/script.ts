// The triage role on the runner's linear mode: the session, then the comment
// that announces its decision, then an end that saves the issue at spec,
// releases it with its questions asked, or stops it. The spec writer opens
// the draft PR, so triage opens no branch or PR. The job claims the issue, checks it out and writes issue.md, and
// the end's save drops the lease, so none of those are steps. Every comment
// is keyed, so a restart edits it rather than posting it again. Pure.

import { noteEvent } from "../../workflow/event-log.ts";
import type { AfterOp, Effect, End } from "../machine.ts";
import type { LinearScript, LinearStep } from "../walk.ts";
import type { TriageData, TriageStop } from "./locate.ts";
import { locate } from "./locate.ts";
import { decisionOf, triageReplyOf } from "./reply.ts";
import {
  announcement,
  keptPlan,
  REJECTED,
  TRIAGE_FAILED,
  triageEvent,
} from "./task.ts";

// The key of triage's one comment on the issue.
const COMMENT_KEY = "triage";

function noted(data: TriageData, text: string): TriageData {
  const next = { ...data };
  noteEvent(next, text, data.at);
  return next;
}

function stopped(data: TriageData, stop: TriageStop): End {
  const { code, reason, detail } = stop;
  const payload = { number: data.issue, code, reason, detail };
  const after: AfterOp = { op: "stop", payload };
  return { kind: "stopped", code, after };
}

// How the run ends, from where it got to.
function endOf(data: TriageData): End {
  const { start, reading } = data;
  if (start.kind === "stop") {
    return stopped(data, start.stop);
  }
  if (reading.kind !== "decided") {
    const stop = { code: "error", reason: TRIAGE_FAILED, detail: null };
    return stopped(data, stop);
  }
  const { decision, reply } = reading;
  switch (decision) {
    case "ready":
    case "split":
      return { kind: "saved", stage: "spec" };
    case "needs-info": {
      const { questions } = reply;
      const payload = { number: data.issue, questions, by: data.by };
      return { kind: "released", after: { op: "ask", payload } };
    }
    case "reject": {
      const { reason } = reply;
      const stop = {
        code: "triage-rejected",
        reason: REJECTED,
        detail: reason,
      };
      return stopped(data, stop);
    }
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
}

function ending(data: TriageData): Effect {
  return { kind: "end", end: endOf(data) };
}

// Reads the session's reply and takes the issue on, or not.
function decide(data: TriageData, output: unknown): TriageData {
  const reply = triageReplyOf(output);
  if (reply === null) {
    return { ...data, reading: { kind: "unreadable" } };
  }
  const decision = decisionOf(reply, data.depth);
  const next = noted(data, triageEvent(reply, decision));
  next.reading = { kind: "decided", decision, reply };
  if (decision === "ready") {
    return { ...next, plan: keptPlan(reply.plan), splitSuggested: null };
  }
  if (decision === "split") {
    return {
      ...next,
      plan: keptPlan(reply.plan),
      splitSuggested: reply.reason,
    };
  }
  return next;
}

const triageStep: LinearStep<TriageData> = {
  name: "triage",
  kind: "session",
  effect: (data: TriageData): Effect => {
    if (data.start.kind === "stop") {
      return ending(data);
    }
    return data.start.session;
  },
  apply: decide,
};

const announceStep: LinearStep<TriageData> = {
  name: "announce",
  kind: "script",
  effect: (data: TriageData): Effect => {
    const { reading } = data;
    if (reading.kind !== "decided") {
      return ending(data);
    }
    const body = announcement(reading.decision, reading.reply.reason);
    if (body === null) {
      return ending(data);
    }
    const { issue: number, by } = data;
    const comments = [{ number, by, body, key: COMMENT_KEY }];
    return { kind: "op", op: "post", payload: { number, comments } };
  },
};

const triageScript: LinearScript<TriageData> = {
  locate,
  steps: [triageStep, announceStep],
  end: endOf,
  handoff: ["plan", "splitSuggested", "triages", "log"],
  checkpoints: [],
};

export { triageScript };
