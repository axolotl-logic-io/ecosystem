// @ts-check
// A stage job's usage effect (src/job/usage-append.ts): a record the
// serializer takes goes to the usage op, a provider-prefixed model id
// included; a refused one is reported on stderr, which is the job's job.log,
// rather than dropped silently; a failed send is tried once more; and every
// job record reaches jobs.jsonl in the issue's run folder, refused or not.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { usageAppender } from "../src/job/usage-append.ts";
import { parseUsageLine } from "../src/job/usage-log.ts";
import { LAUNCH } from "./runner-test-kit.mjs";
import { CONTEXT } from "./usage-fixtures.mjs";

/** @import { UsageEntry } from "../src/job/run-usage.ts" */

const AT = "2026-10-16T12:00:00.000Z";
const PREFIXED_MODEL = "anthropic/claude-opus-5-5";
const REFUSED_SESSION = /^job: usage: dropped the session record: model: /mu;
const REFUSED_JOB = /^job: usage: dropped the job record: outcome: /mu;
const ISSUE_TOKENS = 2640;

/** @param {Record<string, unknown>} [over] @returns {UsageEntry} */
function sessionEntry(over = {}) {
  return /** @type {UsageEntry} */ ({
    kind: "session",
    at: AT,
    key: "i7-spec-1",
    stage: "spec",
    state: "work",
    name: "work",
    agent: "toy-writer",
    model: PREFIXED_MODEL,
    attempt: 1,
    taskChars: 16,
    schema: {},
    ended: "reply",
    reply: null,
    launch: LAUNCH,
    ...over,
  });
}

/** @type {UsageEntry} */
const JOB_ENTRY = {
  kind: "job",
  at: AT,
  stages: ["spec"],
  outcome: "saved",
  seconds: 30,
  tokens: LAUNCH.tokens,
  issueTokens: ISSUE_TOKENS,
};

/**
 * Appends `entry` with a send that answers `answers` in turn (then true),
 * capturing stderr.
 * @param {UsageEntry} entry @param {boolean[]} [answers]
 */
async function appended(entry, answers = []) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-append-"));
  /** @type {string[]} */
  const sent = [];
  /** @param {string} line @returns {Promise<boolean>} */
  function send(line) {
    sent.push(line);
    return Promise.resolve(answers.shift() ?? true);
  }
  let stderr = "";
  const { write } = process.stderr;
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    await usageAppender(CONTEXT, { send, runDir })(entry);
  } finally {
    process.stderr.write = write;
  }
  const jobsFile = path.join(runDir, "jobs.jsonl");
  let jobs = "";
  if (fs.existsSync(jobsFile)) {
    jobs = fs.readFileSync(jobsFile, "utf8");
  }
  fs.rmSync(runDir, { recursive: true, force: true });
  return { sent, stderr, jobs };
}

test("a session whose model id has a provider prefix reaches the usage op with it", async () => {
  const { sent, stderr } = await appended(sessionEntry());
  assert.equal(stderr, "");
  assert.equal(sent.length, 1);
  const record = parseUsageLine(sent[0] ?? "");
  assert.equal(record?.kind === "session" && record.model, PREFIXED_MODEL);
});

test("a refused session record is reported on stderr and sends nothing", async () => {
  const { sent, stderr } = await appended(sessionEntry({ model: "a b" }));
  assert.deepEqual(sent, []);
  assert.match(stderr, REFUSED_SESSION);
});

test("a failed send is tried once more, and a job record lands in jobs.jsonl", async () => {
  const { sent, jobs } = await appended(JOB_ENTRY, [false, false]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  const [line, ...more] = jobs.trim().split("\n");
  assert.deepEqual(more, []);
  assert.deepEqual(JSON.parse(line ?? ""), parseUsageLine(sent[0] ?? ""));
});

test("a refused job record still lands in jobs.jsonl, and stderr says why", async () => {
  const refused = { ...JOB_ENTRY, outcome: "not a name" };
  const { sent, stderr, jobs } = await appended(refused);
  assert.deepEqual(sent, []);
  assert.match(stderr, REFUSED_JOB);
  assert.equal(JSON.parse(jobs).outcome, "not a name");
});
