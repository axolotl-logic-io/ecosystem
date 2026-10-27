import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";

// What a task record looks like once it may be posted to GitHub: the
// hidden record and its prose name no local path or IP address. The ops
// child runs with this machine's home and pipeline root, so the check runs
// in a child with known ones.

const SOURCE = path.resolve(import.meta.dirname, "../..");
const HOME = "/opt/tester";
const ROOT = "/srv/pipeline";
const SHA_LENGTH = 40;
const DIGEST_LENGTH = 64;
const SHA = "1".repeat(SHA_LENGTH);
const DIGEST = "a".repeat(DIGEST_LENGTH);
const SCRIPT = `
import fs from 'node:fs';
import { publicRecord } from './src/ops/task-ledger.ts';
import { recordBody } from './src/tasks/records.ts';
const record = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  const posted = publicRecord(record);
  console.log(JSON.stringify({ body: recordBody(posted), refused: null }));
} catch (error) {
  console.log(JSON.stringify({ body: null, refused: error.message }));
}
`;
const OUTCOME = z.strictObject({
  body: z.string().nullable(),
  refused: z.string().nullable(),
});
const LOCAL = new RegExp(
  `${HOME}|${ROOT}|/var/folders|/private/|/tmp/|/Users/|/home/|10\\.0\\.0\\.5|fe80::1`,
  "u",
);
const NOT_CLEAN = /local path or address outside its receipt/u;

function publicOf(record: object): z.infer<typeof OUTCOME> {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", SCRIPT],
    {
      cwd: SOURCE,
      encoding: "utf8",
      input: JSON.stringify(record),
      env: {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: environment variable names
        HOME,
        // biome-ignore lint/style/useNamingConvention: environment variable names
        ISSUE_PIPELINE_ROOT: ROOT,
      },
    },
  );
  if (run.status !== 0) {
    throw new Error(run.stderr);
  }
  return OUTCOME.parse(JSON.parse(run.stdout));
}

interface ResultRecord {
  version: number;
  kind: string;
  binding: object;
  run: { id: string; previous: null };
  buddyRun: string;
  cause: { signal: string; recordId: number };
  verdict: string;
  receipt: object;
}

function result(receipt: object, branch = "main"): ResultRecord {
  return {
    version: 2,
    kind: "result",
    binding: {
      workItem: { repo: "owner/repo", number: 7 },
      task: "implement",
      target: { branch, commit: SHA },
      requirements: `sha256:${DIGEST}`,
    },
    run: { id: "6f1c1f0e-6a43-4c8e-9a51-0d4b8f2f5e11", previous: null },
    buddyRun: "0b4e7f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    cause: { signal: "result:12", recordId: 12 },
    verdict: "failed",
    receipt,
  };
}

test("a result's summary, evidence and prose name no local path or address", () => {
  const { body, refused } = publicOf(
    result({
      summary: `checks failed in ${ROOT}/runs/x and /var/folders/ab/T/tmp.1 via 10.0.0.5:8080`,
      evidence: {
        checks: [
          {
            command: `${HOME}/bin/check --cache /tmp/cache`,
            exit: 1,
            log: "see file:///Users/someone/log.txt or [fe80::1]:22",
          },
        ],
        branch: "agent/issue-7",
        head: SHA,
      },
    }),
  );
  assert.equal(refused, null);
  assert.ok(body !== null);
  assert.doesNotMatch(body, LOCAL);
  assert.ok(body.includes("$ISSUE_PIPELINE_ROOT/runs/x"));
  assert.ok(body.includes("~/bin/check --cache [local path]"));
  assert.ok(body.includes("file://[local path]"));
  // Identifiers and URLs on GitHub stay as they are.
  assert.ok(body.includes('"branch":"agent/issue-7"'));
  assert.ok(body.includes(SHA));
});

test("a URL's path after its host is not a local path", () => {
  const { body } = publicOf(
    result({ summary: "see https://example.com/home/tmp/Users for details" }),
  );
  assert.ok(body?.includes("https://example.com/home/tmp/Users"));
});

test("a local path outside the receipt refuses the record instead of changing it", () => {
  const { body, refused } = publicOf(
    result({ summary: "failed" }, "/tmp/stray"),
  );
  assert.equal(body, null);
  assert.match(refused ?? "", NOT_CLEAN);
});
