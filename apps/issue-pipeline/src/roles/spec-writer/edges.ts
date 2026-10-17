// How each result's reply changes the spec writer's `data` as the machine
// (machine.ts) takes an edge: the start heads checkout found, what the stage
// committed since them, the session's reply as read, the ready spec's hand-off fields, the head with its tests
// committed, the spec as published, and a failure's output; and what the
// later states read from the reply. Pure.

import { isRecord, isStrings } from "../../workflow/stages/reply-guards.ts";
import type { SpecData } from "./locate.ts";
import type { SpecWriterReply } from "./reply.ts";
import { specReadingOf } from "./reply.ts";
import type { SpecCommitted } from "./task.ts";
import { FAILED_TWICE } from "./task.ts";

// The session's reply, as the role reads it.
function read(data: SpecData, reply: unknown): SpecData {
  return { ...data, reply: specReadingOf(reply, data.depth) };
}

// A failure's output, which the retry's task includes.
function failed(data: SpecData, reply: unknown): SpecData {
  return { ...data, checkOutput: String(reply) };
}

function shaOf(value: unknown): string | null | undefined {
  if (typeof value === "string" || value === null) {
    return value;
  }
  return undefined;
}

function committedOf(value: unknown): SpecCommitted | null {
  if (!isRecord(value)) {
    return null;
  }
  const { tests, stubs, wiki, draft } = value;
  if (!(isStrings(tests) && isStrings(stubs) && isStrings(wiki))) {
    return null;
  }
  return { tests, stubs, wiki, draft: draft === true };
}

// What the stage committed since its start heads, as listed.
function found(data: SpecData, reply: unknown): SpecData {
  if (!isRecord(reply)) {
    return data;
  }
  const { committed } = reply;
  return { ...data, committed: committedOf(committed) };
}

// The start heads checkout found, unless an earlier start saved them, and
// what the stage committed since them.
function started(data: SpecData, reply: unknown): SpecData {
  if (!isRecord(reply)) {
    return data;
  }
  const { startSha, startWikiSha } = reply;
  const next = found(data, reply);
  if (data.startSha === undefined) {
    next.startSha = shaOf(startSha);
  }
  if (data.startWikiSha === undefined) {
    next.startWikiSha = shaOf(startWikiSha);
  }
  return next;
}

// The ready reply's hand-off fields.
function readied(data: SpecData): SpecData {
  const { reply } = data;
  if (reply?.kind !== "ready") {
    return data;
  }
  const { spec, files, interfaces, noTestsReason } = reply.reply;
  return { ...data, spec, files, interfaces, noTestsReason };
}

function testsCommitted(data: SpecData, reply: unknown): SpecData {
  if (!isRecord(reply)) {
    return data;
  }
  const { sha } = reply;
  if (typeof sha !== "string") {
    return data;
  }
  return { ...data, specTestsSha: sha };
}

// The spec as published: the saved copy and where the whole of it is, if
// it was too long to keep, with its tests written by this role.
function published(data: SpecData, reply: unknown): SpecData {
  if (!isRecord(reply)) {
    return data;
  }
  const { spec, specFile } = reply;
  const next: SpecData = { ...data, specFile: null, specWritesTests: true };
  if (typeof spec === "string") {
    next.spec = spec;
  }
  if (typeof specFile === "string") {
    next.specFile = specFile;
  }
  return next;
}

// The draft PR start-pr opened or found, which the implementor builds on.
function prOpened(data: SpecData, reply: unknown): SpecData {
  if (!isRecord(reply)) {
    return data;
  }
  const { pr, headSha } = reply;
  const next: SpecData = { ...data, implemented: false };
  if (typeof pr === "number") {
    next.pr = pr;
  }
  if (typeof headSha === "string") {
    next.headSha = headSha;
  }
  return next;
}

// What the ask, split and no-work ops post from the decided reply.
function decided(
  data: SpecData,
): Pick<SpecWriterReply, "spec" | "questions" | "subIssues"> {
  const { reply } = data;
  if (reply === null || !("reply" in reply)) {
    return { spec: "", questions: [], subIssues: [] };
  }
  const { spec, questions, subIssues } = reply.reply;
  return { spec, questions, subIssues };
}

// The summary of the handoff the last session replied with, if any.
function handoffSummary(data: SpecData): string {
  const { reply } = data;
  if (reply?.kind !== "handoff") {
    return "";
  }
  return reply.summary;
}

// The reason a run stops with after a refused split or a second failure.
function refusal(data: SpecData): string {
  const { reply } = data;
  if (reply?.kind === "refused") {
    return reply.reason;
  }
  return FAILED_TWICE;
}

export {
  decided,
  failed,
  found,
  handoffSummary,
  prOpened,
  published,
  read,
  readied,
  refusal,
  started,
  testsCommitted,
};
