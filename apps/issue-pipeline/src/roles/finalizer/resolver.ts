// The finalizer's conflict resolution of the wiki's rebase: a writer session
// finishes the rebase that stopped on conflicts (resolve), handing off to a
// continuation on the same rebase up to config maxContinuations, then the
// rebase is finished or aborted (finish-wiki-sync) and the resolver's reply
// decides whether the run goes on to the wiki check, holds for the next
// tick or stops. Conflicts never wait for a human: a fresh resolver tries
// again next tick, up to maxConflictFixes. The resolver's comments ride on
// the finish's request. Pure.

import type { Signature } from "../../workflow/signing.ts";
import type {
  FinishReply,
  FixOutput,
} from "../../workflow/stages/checks-reply.ts";
import {
  finishReplyOf,
  fixOf,
  isRecord,
} from "../../workflow/stages/checks-reply.ts";
import {
  maxConflictFixes,
  resolverSession,
} from "../../workflow/stages/conflict-resolver.ts";
import {
  continuationsOf,
  continued,
  mayContinue,
  outOfRoomReason,
} from "../../workflow/stages/continuation.ts";
import { isTransientSessionError } from "../../workflow/stages/rate-limit.ts";
import type { ChildLaunch } from "../../workflow/stages/types.ts";
import type { Effect, SessionEffect } from "../machine.ts";
import type { LinearStep } from "../walk.ts";
import { ended, endOf, held, noted, stoppedFor } from "./ends.ts";
import type { FinalizerData, WikiConflict } from "./locate.ts";
import { fileListOf } from "./wiki.ts";

// The resolver's session for `conflict`, a continuation while the resolver
// is continuing.
function launchOf(data: FinalizerData, conflict: WikiConflict): ChildLaunch {
  const { files, baseSha, branch } = conflict;
  let continuation: number | null = null;
  if (data.resolution.kind === "continuing") {
    continuation = continuationsOf(data, "conflicts");
  }
  return resolverSession(data.item, data.settings, {
    conflict: { files, baseSha, target: { kind: "wiki", branch } },
    attempt: data.conflictFixes,
    continuation,
  });
}

function sessionOf(launch: ChildLaunch, attempt: number): SessionEffect {
  const { name, agent, model, schema, task, minutes } = launch;
  const { tokenBudget, budgetRole } = launch;
  return {
    kind: "session",
    name,
    agent,
    model,
    schema,
    task,
    tokenBudget,
    budgetRole,
    attempt,
    minutes,
    writer: true,
  };
}

function resolverEffect(data: FinalizerData): Effect {
  const { conflict } = data;
  if (conflict === null) {
    return { kind: "end", end: endOf(data) };
  }
  return sessionOf(launchOf(data, conflict), data.conflictFixes);
}

// How the resolver's comment begins, by its status.
function leadOf(fix: FixOutput, branch: string): string {
  const { status } = fix;
  switch (status) {
    case "fixed":
      return "";
    case "cannot-fix":
      return `I couldn't resolve the conflicts with the wiki's ${branch}: `;
    case "handoff":
      return "I ran out of room before finishing the rebase: ";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

// `data` with the resolver's comment on `fix` queued for the PR.
function withComment(
  data: FinalizerData,
  conflict: WikiConflict,
  fix: FixOutput,
): FinalizerData {
  const attempt = data.conflictFixes;
  const { agent, model } = launchOf(data, conflict);
  const role = `conflict resolver (attempt ${attempt})`;
  const by: Signature = { role, agent, model, run: data.jobId };
  const taken = continuationsOf(data, "conflicts");
  const comment = {
    number: data.st.pr ?? data.issue,
    by,
    body: leadOf(fix, conflict.branch) + fix.summary,
    key: `wiki-conflicts-${attempt}-c${taken}`,
  };
  return { ...data, comments: [...data.comments, comment] };
}

// Reads the resolver's reply: a handoff below the cap continues, anything
// else settles the resolution.
function replied(data: FinalizerData, output: unknown): FinalizerData {
  const fix = fixOf(output);
  const { conflict } = data;
  if (fix === null || conflict === null) {
    return { ...data, resolution: { kind: "settled", fix: null, error: null } };
  }
  const commented = withComment(data, conflict, fix);
  const { cfg } = data.settings;
  if (fix.status === "handoff" && mayContinue(data, cfg, "conflicts")) {
    const next = continued(commented, "conflicts");
    return { ...next, resolution: { kind: "continuing" } };
  }
  return { ...commented, resolution: { kind: "settled", fix, error: null } };
}

function finishEffect(data: FinalizerData): Effect {
  const { resolution } = data;
  let fix: FixOutput | null = null;
  if (resolution.kind === "settled") {
    ({ fix } = resolution);
  }
  const abort = fix === null || fix.status !== "fixed";
  const reason = fix?.summary ?? "the conflict resolver failed";
  const { issue: number, comments } = data;
  const payload = { number, abort, reason, comments };
  return { kind: "op", op: "finish-wiki-sync", payload };
}

// A resolver whose session failed with `error`. A transient provider error
// gives back the attempt and continuations the run took, as the sweep's
// rate-limit deferral does, so the save before the rebase's finish and the
// rate-limited hold that follows count none (`rate-limit-defers`).
function sessionLost(data: FinalizerData, error: string): FinalizerData {
  const failed: FinalizerData = {
    ...data,
    resolution: { kind: "settled", fix: null, error },
  };
  if (!isTransientSessionError(error)) {
    return failed;
  }
  const { conflictFixes = 0, continuations = {} } = data.st;
  return { ...failed, conflictFixes, continuations };
}

// A resolver whose session failed: held for the next tick on a transient
// provider error once its rebase is aborted; stopped otherwise.
function sessionFailed(
  data: FinalizerData,
  reply: FinishReply,
  error: string | null,
  files: string,
): FinalizerData {
  if (isTransientSessionError(error) && reply.kind !== "failed") {
    return ended(data, { kind: "held", rateLimited: true });
  }
  const why = "the conflict-resolver session failed";
  return stoppedFor(data, why, `${files}\n\n${error ?? ""}`);
}

// A fixed resolution once the rebase is finished: the run goes on to the
// wiki check, or a rejected one holds, and stops on the last attempt.
function finished(
  data: FinalizerData,
  reply: FinishReply,
  conflict: WikiConflict,
): FinalizerData {
  const { kind } = reply;
  switch (kind) {
    case "failed": {
      const why = "could not finish the rebase after resolving conflicts";
      return stoppedFor(data, why, reply.error);
    }
    case "rejected": {
      if (data.conflictFixes >= maxConflictFixes(data.settings)) {
        const files = fileListOf(conflict.files);
        const why = "the conflict resolution was rejected";
        return stoppedFor(data, why, `${files}\n\n${reply.reason}`);
      }
      const note = `conflict resolution rejected: ${reply.reason}; will retry`;
      return held(noted(data, note));
    }
    case "resolved":
      return noted(
        data,
        `resolved the wiki's conflicts with the wiki's ${conflict.branch}`,
      );
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

// Acts on the resolver's reply and the finished or aborted rebase.
function settle(data: FinalizerData, reply: FinishReply): FinalizerData {
  const sent = { ...data, comments: [] };
  const { resolution, conflict } = data;
  if (resolution.kind !== "settled" || conflict === null) {
    return sent;
  }
  const { fix, error } = resolution;
  const files = fileListOf(conflict.files);
  if (fix === null) {
    return sessionFailed(sent, reply, error, files);
  }
  const { status, summary } = fix;
  switch (status) {
    case "cannot-fix": {
      const note = `conflict resolver found no resolution: ${summary}; will retry`;
      return held(noted(sent, note));
    }
    case "handoff": {
      const { cfg } = data.settings;
      const why = outOfRoomReason("conflict resolver", cfg.maxContinuations);
      const { handoffFile } = data.item.paths;
      const detail = `${files}\n\nLatest handoff: ${handoffFile}\n\n${summary}`;
      return stoppedFor(sent, why, detail);
    }
    case "fixed":
      return finished(sent, reply, conflict);
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

function finishReplyFrom(reply: unknown): FinishReply {
  if (!isRecord(reply)) {
    return {
      kind: "failed",
      error: "the finish-wiki-sync reply is unreadable",
    };
  }
  return finishReplyOf(reply);
}

const resolveStep: LinearStep<FinalizerData> = {
  name: "resolve",
  kind: "session",
  skip: (data: FinalizerData): boolean =>
    data.end !== null ||
    data.conflict === null ||
    data.resolution.kind === "settled",
  effect: resolverEffect,
  apply: replied,
  recover: sessionLost,
  again: (data: FinalizerData): boolean =>
    data.resolution.kind === "continuing",
};

const finishWikiSyncStep: LinearStep<FinalizerData> = {
  name: "finish-wiki-sync",
  kind: "script",
  skip: (data: FinalizerData): boolean =>
    data.end !== null || data.resolution.kind !== "settled",
  effect: finishEffect,
  apply: (data: FinalizerData, reply: unknown): FinalizerData =>
    settle(data, finishReplyFrom(reply)),
  recover: (data: FinalizerData, error: string): FinalizerData =>
    settle(data, { kind: "failed", error }),
};

export { finishWikiSyncStep, resolveStep };
