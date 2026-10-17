// @ts-check
// Usage log fixtures (src/job/usage-log.ts): a whole session record and a
// job record as the serializer accepts them, with fields to override, and
// the context a role job gives its records.

/** @import { UsageContext } from "../src/job/usage-log.ts" */

const JOB_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

/** @type {UsageContext} */
const CONTEXT = {
  repo: "o/r",
  issue: 7,
  job: JOB_ID,
  role: "spec-writer",
  limits: { soft: 150_000, hard: 175_000 },
};

/**
 * A session record, as the serializer accepts it, with `over` on top.
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function sessionRecord(over = {}) {
  return {
    kind: "session",
    at: "2026-10-16T12:00:00.000Z",
    repo: "o/r",
    issue: 7,
    job: JOB_ID,
    role: "spec-writer",
    stage: "spec",
    state: "work",
    name: "work",
    agent: "toy-writer",
    model: "mock",
    attempt: 1,
    ended: "reply",
    reply: null,
    seconds: 7,
    turns: 3,
    tokens: { input: 900, output: 120, cacheRead: 4000, cacheWrite: 300 },
    context: {
      first: 1200,
      peak: 5300,
      atFinish: 5000,
      soft: 150_000,
      hard: 175_000,
      window: null,
      steered: false,
    },
    task: { chars: 16, files: {} },
    tools: { read: { calls: 2, outputChars: 800 } },
    largestToolOutput: { tool: "read", chars: 500 },
    ...over,
  };
}

/**
 * A job record, as the serializer accepts it, with `over` on top.
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function jobRecord(over = {}) {
  return {
    kind: "job",
    at: "2026-10-16T12:00:00.000Z",
    repo: "o/r",
    issue: 7,
    job: JOB_ID,
    role: "spec-writer",
    stages: ["spec", "implement"],
    outcome: "saved",
    seconds: 30,
    tokens: { input: 900, output: 120, cacheRead: 4000, cacheWrite: 300 },
    issueTokens: 0,
    ...over,
  };
}

export { CONTEXT, JOB_ID, jobRecord, sessionRecord };
