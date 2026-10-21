// @ts-check
// Usage log fixtures (src/job/usage-log.ts): a finished launch's tally, the
// job's session and job entries (src/job/run-usage.ts) built from it, the
// session and job records the serializer accepts for them, with fields to
// override, and the context a role job gives its records. The records are
// what usageRecord and jobRecord make of the entries under CONTEXT.

import { pinnedOf } from "./prompt-test-kit.mjs";

/** @import { UsageContext } from "../src/job/usage-log.ts" */
/** @import { JobEntry, SessionEntry } from "../src/job/run-usage.ts" */
/** @import { LaunchUsage } from "../src/job/usage-tally.ts" */

const JOB_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const JOB_STARTED_AT = "2026-10-16T11:59:00.000Z";
const AT = "2026-10-16T12:00:00.000Z";
const ISSUE = 7;
const TASK_CHARS = 16;
const JOB_SECONDS = 30;
// The implementor's pinned prompt, as a session's entry and record name it.
const { path: _pinnedAt, ...PROMPT } = pinnedOf("developer.md").provenance;

/** @type {LaunchUsage} */
const LAUNCH = {
  turns: 3,
  tokens: {
    input: 900,
    output: 120,
    cacheRead: 4000,
    cacheWrite: 300,
    cacheWrite1h: 300,
    cost: 0.25,
  },
  first: 1200,
  peak: 5300,
  atFinish: 5000,
  tools: { read: { calls: 2, outputChars: 800 } },
  largest: { tool: "read", chars: 500 },
  seconds: 7,
};

/** @type {UsageContext} */
const CONTEXT = {
  repo: "o/r",
  issue: ISSUE,
  job: JOB_ID,
  jobStartedAt: JOB_STARTED_AT,
  role: "implementor",
};

/**
 * A finished implementor session as the job knows it, with `over` on top.
 * @param {Partial<SessionEntry>} [over]
 * @returns {SessionEntry}
 */
function sessionEntry(over = {}) {
  return {
    kind: "session",
    at: AT,
    key: "i7-implementor-1",
    stage: "implement",
    state: "implement",
    name: "implementor",
    agent: "issue-pipeline-implementor",
    model: "mock",
    attempt: 1,
    taskChars: TASK_CHARS,
    prompt: PROMPT,
    ended: "reply",
    reply: { outcome: "done" },
    launch: LAUNCH,
    ...over,
  };
}

/**
 * A finished job as the job knows it, with `over` on top.
 * @param {Partial<JobEntry>} [over]
 * @returns {JobEntry}
 */
function jobEntry(over = {}) {
  return {
    kind: "job",
    at: AT,
    stages: ["implement", "review"],
    outcome: "saved",
    seconds: JOB_SECONDS,
    tokens: LAUNCH.tokens,
    ...over,
  };
}

/**
 * The session record of sessionEntry() under CONTEXT, as the serializer
 * accepts it, with `over` on top.
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function sessionRecord(over = {}) {
  return {
    kind: "session",
    at: AT,
    repo: CONTEXT.repo,
    issue: ISSUE,
    job: JOB_ID,
    jobStartedAt: JOB_STARTED_AT,
    role: CONTEXT.role,
    key: "i7-implementor-1",
    stage: "implement",
    state: "implement",
    name: "implementor",
    agent: "issue-pipeline-implementor",
    model: "mock",
    attempt: 1,
    ended: "reply",
    reply: "done",
    seconds: LAUNCH.seconds,
    turns: LAUNCH.turns,
    tokens: LAUNCH.tokens,
    context: {
      first: LAUNCH.first,
      peak: LAUNCH.peak,
      atFinish: LAUNCH.atFinish,
      window: null,
    },
    task: { chars: TASK_CHARS, files: {} },
    prompt: PROMPT,
    tools: LAUNCH.tools,
    largestToolOutput: LAUNCH.largest,
    ...over,
  };
}

/**
 * The job record of jobEntry() under CONTEXT, as the serializer accepts it,
 * with `over` on top.
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function jobRecord(over = {}) {
  return {
    kind: "job",
    at: AT,
    repo: CONTEXT.repo,
    issue: ISSUE,
    job: JOB_ID,
    jobStartedAt: JOB_STARTED_AT,
    role: CONTEXT.role,
    stages: ["implement", "review"],
    outcome: "saved",
    seconds: JOB_SECONDS,
    tokens: LAUNCH.tokens,
    ...over,
  };
}

export {
  CONTEXT,
  JOB_ID,
  JOB_STARTED_AT,
  jobEntry,
  jobRecord,
  LAUNCH,
  sessionEntry,
  sessionRecord,
};
