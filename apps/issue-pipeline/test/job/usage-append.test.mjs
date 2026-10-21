// @ts-check
// A stage job's usage effect (src/job/usage-append.ts): a record the
// serializer takes goes to the usage op, a provider-prefixed model id
// included; a refused one is reported on stderr, which is the job's job.log,
// rather than dropped silently; a failed send is tried once more; and every
// job record reaches jobs.jsonl in the issue's run folder, refused or not.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { isolatedRoot } from "../isolated-root-test-kit.mjs";
import { CONTEXT, jobEntry, sessionEntry } from "../usage-fixtures.mjs";

const { usageAppender } = await import("../../src/job/usage-append.ts");
const { parseUsageLine } = await import("../../src/job/usage-log.ts");

/** @import { UsageEntry } from "../../src/job/run-usage.ts" */

const PREFIXED_MODEL = "anthropic/claude-opus-5-5";
const REFUSED_SESSION = /^job: usage: dropped the session record: model: /mu;
const REFUSED_JOB = /^job: usage: dropped the job record: outcome: /mu;
const JOB_ENTRY = jobEntry();

/**
 * Appends `entry` with a send that answers `answers` in turn (then true),
 * capturing stderr.
 * @param {UsageEntry} entry @param {boolean[]} [answers]
 */
async function appended(entry, answers = []) {
  const runDir = fs.mkdtempSync(path.join(isolatedRoot, "usage-append-"));
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
  const { sent, stderr } = await appended(
    sessionEntry({ model: PREFIXED_MODEL }),
  );
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
