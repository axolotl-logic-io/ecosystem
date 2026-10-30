import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";

// The v2 task ledger as the ops child reads it: the landing account's
// comments, checked in order, and a proposed record refused before it is
// written when the next reader would hold on it.

const SOURCE = path.resolve(import.meta.dirname, "../..");
const LANDING = "lawd-bot";
const REPO = "owner/repo";
const SHA_LENGTH = 40;
const DIGEST_LENGTH = 64;
const T = "1".repeat(SHA_LENGTH);
const R = "2".repeat(SHA_LENGTH);
const DIGEST = "a".repeat(DIGEST_LENGTH);
const UNSETTLED_REPEAT = /repeated an unsettled attempt/u;
const PASSED_RERUN = /reran a passed binding/u;
const BUDGET_SPENT = /exceeds the binding's 3 attempts/u;
const NOT_ITS_ATTEMPT = /does not name its attempt exactly/u;
const NOT_LANDING = /not the landing account's own record/u;
const READER = `
import fs from 'node:fs';
import { readRecords, recordBody, withProposed, statusOf } from './src/tasks/records.ts';
const spec = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const cfg = { repo: spec.repo, landingAccount: spec.landing };
const comments = spec.records.map(({ author, prose, body, ...record }, at) => ({
  id: at + 1,
  body: body ?? recordBody(record, prose ?? ''),
  user: { login: author ?? spec.landing },
  lastEditedAt: null,
  editor: null,
}));
try {
  const records = readRecords(cfg, spec.number, comments);
  const status = statusOf(records.rows, spec.binding).status;
  if (spec.proposed !== null) {
    withProposed(records, spec.proposed, Number.MAX_SAFE_INTEGER);
  }
  console.log(JSON.stringify({ hold: null, status }));
} catch (error) {
  console.log(JSON.stringify({ hold: error.message, status: null }));
}
`;
const OUTCOME = z.strictObject({
  hold: z.string().nullable(),
  status: z.string().nullable(),
});

const BINDING: object = {
  workItem: { repo: REPO, number: 7 },
  task: "verify",
  target: { branch: "main", commit: T },
  revision: { code: R, inputs: DIGEST, policy: DIGEST },
};
const BUDDY_RUN = randomUUID();
const CAUSE = { signal: "result:1", recordId: 1 };

interface Attempt {
  version: 2;
  kind: "attempt";
  binding: object;
  run: { id: string; previous: string | null };
  buddyRun: string;
  cause: { signal: string; recordId: number };
}

interface Result extends Omit<Attempt, "kind"> {
  kind: "result";
  verdict: string;
  receipt: { summary: string };
}

function attempt(id: string, previous: string | null): Attempt {
  return {
    version: 2,
    kind: "attempt",
    binding: BINDING,
    run: { id, previous },
    buddyRun: BUDDY_RUN,
    cause: CAUSE,
  };
}

function result(id: string, previous: string | null, verdict: string): Result {
  return {
    version: 2,
    kind: "result",
    binding: BINDING,
    run: { id, previous },
    buddyRun: BUDDY_RUN,
    cause: CAUSE,
    verdict,
    receipt: { summary: `${verdict} on ${R}` },
  };
}

function read(
  records: readonly object[],
  proposed: object | null,
): z.infer<typeof OUTCOME> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-ledger-"));
  try {
    const file = path.join(root, "spec.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        repo: REPO,
        landing: LANDING,
        number: 7,
        binding: BINDING,
        records,
        proposed,
      }),
    );
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", READER, file],
      { cwd: SOURCE, encoding: "utf8" },
    );
    if (run.status !== 0) {
      throw new Error(run.stderr);
    }
    return OUTCOME.parse(JSON.parse(run.stdout));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("an unknown binding never repeats", () => {
  const first = randomUUID();
  const outcome = read([attempt(first, null)], attempt(randomUUID(), first));
  assert.equal(outcome.status, null);
  assert.match(outcome.hold ?? "", UNSETTLED_REPEAT);
});

test("a passed binding never reruns", () => {
  const first = randomUUID();
  const outcome = read(
    [attempt(first, null), result(first, null, "passed")],
    attempt(randomUUID(), first),
  );
  assert.match(outcome.hold ?? "", PASSED_RERUN);
});

test("a failed binding retries within its budget of three attempts", () => {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  const settled = [
    attempt(a, null),
    result(a, null, "failed"),
    attempt(b, a),
    result(b, a, "failed"),
  ];
  const third = read(settled, attempt(c, b));
  assert.deepEqual(third, { hold: null, status: "failed" });
  const spent = read(
    [...settled, attempt(c, b), result(c, b, "failed")],
    attempt(randomUUID(), c),
  );
  assert.match(spent.hold ?? "", BUDGET_SPENT);
});

test("a result must name its own attempt's buddy run and cause", () => {
  const first = randomUUID();
  const forged = { ...result(first, null, "passed"), buddyRun: randomUUID() };
  const outcome = read([attempt(first, null)], forged);
  assert.match(outcome.hold ?? "", NOT_ITS_ATTEMPT);
});

test("result prose cannot change the hidden verdict, even when it contains another marker", () => {
  const first = randomUUID();
  const prose = `Finished the review.\n${JSON.stringify({ verdict: "failed" })}\n<!-- agent-pipeline:task-result\nnot a record\n-->`;
  const outcome = read(
    [attempt(first, null), { ...result(first, null, "passed"), prose }],
    null,
  );
  assert.deepEqual(outcome, { hold: null, status: "passed" });
});

test("prose cannot repair a malformed hidden record", () => {
  const outcome = read(
    [
      {
        body: "<!-- agent-pipeline:task-result\nnot JSON\n-->\n\nThe review passed.",
      },
    ],
    null,
  );
  assert.equal(outcome.status, null);
  assert.ok(outcome.hold?.includes("unreadable record"));
});

test("a record by any account but the landing account holds the item", () => {
  const first = randomUUID();
  const outcome = read(
    [{ ...attempt(first, null), author: "someone-else" }],
    null,
  );
  assert.match(outcome.hold ?? "", NOT_LANDING);
});

test("a record of the retired Author task is skipped rather than held", () => {
  const first = randomUUID();
  const retired = {
    ...attempt(randomUUID(), null),
    binding: {
      workItem: { repo: REPO, number: 7 },
      task: "author",
      target: { branch: "main", commit: T },
      requirements: DIGEST,
    },
  };
  const outcome = read(
    [
      {
        body: `<!-- agent-pipeline:task-result\n${JSON.stringify(retired)}\n-->`,
      },
      attempt(first, null),
      result(first, null, "passed"),
    ],
    null,
  );
  assert.deepEqual(outcome, { hold: null, status: "passed" });
});
