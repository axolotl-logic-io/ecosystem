// A stage job's invocation binding (#167, #150), through the real job
// against the private fake GitHub (fake-job-coordination.ts), which keeps
// only the coordination records the job's real transport wrote. The fake
// ops would answer every claim with a win, so a job that starts anything
// without confirmed ownership shows up as an op, a checkout or a pi start.
import assert from "node:assert/strict";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { JobLine } from "../../src/job/role-end.ts";
import { waitFor } from "../bounded-test-kit.ts";
import { IMPLEMENTOR_SESSION, implementReplies } from "../job-fixtures.ts";
import type { CoordinationRow } from "./fake-job-coordination.ts";
import { coordinationRecords } from "./fake-job-coordination.ts";
import type { JobEnd, OpsLine, Place } from "./job-test-kit.ts";
import {
  logOf,
  piCommands,
  piStarts,
  runJob,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.ts";

const OWNER_ARGS = ["--stage", "implement", "--lane", "L"];
const OTHER_LANE = ["--stage", "implement", "--lane", "M"];
const UUID = /^[0-9a-f-]{36}$/u;
const FORGED_ID = 5;
const ISSUE_NUMBER = 7;
const UNTRUSTED = /untrusted author\/editor provenance/u;

// Returns the job checkouts on disk
function checkouts(place: Place): string[] {
  const dir = path.join(place.root, "work", "o__r", "jobs");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir);
}

function snapshotOf(place: Place): {
  ops: number;
  pi: number;
  checkouts: string[];
  status: string;
} {
  return {
    ops: logOf(place, "ops.log").length,
    pi: piStarts(place).length,
    checkouts: checkouts(place),
    status: fs.readFileSync(path.join(place.runDir, "job.json"), "utf8"),
  };
}

// Returns an owner job waiting in its writer session
async function liveOwner(
  place: Place,
): Promise<{ child: ChildProcess; end: Promise<JobEnd> }> {
  const owner = startJob(place, OWNER_ARGS);
  await waitFor("the owner's writer session got its prompt", () =>
    piCommands(place).some(({ type }) => type === "prompt"),
  );
  return owner;
}

// Runs a duplicate job: its line, and what it changed of the owner's run,
// which must be nothing (no op, pi start, checkout or job.json write).
function duplicate(
  place: Place,
  args: readonly string[],
): {
  r: SpawnSyncReturns<string>;
  line: JobLine | null;
  before: { ops: number; pi: number; checkouts: string[]; status: string };
  after: { ops: number; pi: number; checkouts: string[]; status: string };
} {
  const before = snapshotOf(place);
  const r = runJob(place, args);
  return {
    r,
    line: JSON.parse(r.stdout || "null"),
    before,
    after: snapshotOf(place),
  };
}

const REFUSED = {
  end: "unclaimed",
  reason: "another invocation owns the issue",
};

// Returns the records for the issue's requests, by kind
function kinds(place: Place): CoordinationRow["kind"][] {
  return coordinationRecords(place.root).map(({ kind }) => kind);
}

test("a job mints its own invocation UUID, never its --job-id, and binds every op to it before it opens a checkout", () => {
  const place = setUp(implementReplies(), IMPLEMENTOR_SESSION);
  const jobId = randomUUID();
  const r = runJob(place, [...OWNER_ARGS, "--job-id", jobId]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).end, "next");
  const [request, confirm, release] = coordinationRecords(place.root);
  assert.deepEqual(kinds(place), ["request", "confirm", "release"]);
  assert.ok(
    request?.kind === "request" &&
      confirm?.kind === "confirm" &&
      release?.kind === "release",
  );
  const { identity } = request;
  assert.match(identity.instance, UUID);
  assert.notEqual(identity.instance, jobId);
  const status = statusOf(place);
  assert.ok(status);
  assert.notEqual(identity.instance, status.id);
  assert.deepEqual(
    { ...identity, instance: null },
    {
      instance: null,
      lane: "L",
      issue: 7,
      branch: "agent/issue-7",
      repo: "o/r",
      base: JSON.parse(fs.readFileSync(place.config, "utf8")).baseBranch,
    },
  );
  assert.equal(confirm.request, request.id);
  assert.equal(release.request, request.id);
  const ops = logOf<OpsLine>(place, "ops.log");
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.deepEqual(op.execution, identity, op.op);
  }
  assert.equal(piStarts(place).length, 1);
});

test("duplicates on the same and another lane, while the owner's writer runs, start nothing and leave the owner's run as it was", async () => {
  const place = setUp(implementReplies(), {
    events: ["wait", ...IMPLEMENTOR_SESSION.events],
  });
  const owner = await liveOwner(place);
  for (const args of [OWNER_ARGS, OTHER_LANE]) {
    const { r, line, before, after } = duplicate(place, args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual({ end: line?.end, reason: line?.reason }, REFUSED);
    assert.deepEqual(after, before);
  }
  assert.deepEqual(kinds(place), [
    "request",
    "confirm",
    "request",
    "cancel",
    "request",
    "cancel",
  ]);
  owner.child.kill("SIGTERM");
  await owner.end;
});

test("a killed owner's expired lease grants a duplicate nothing: its ownership holds for reconciliation", async () => {
  // The scripted claim's saved lease dates from 2026-10-18, long lapsed.
  const place = setUp(implementReplies(), {
    events: ["wait", ...IMPLEMENTOR_SESSION.events],
  });
  const owner = await liveOwner(place);
  owner.child.kill("SIGKILL");
  assert.equal((await owner.end).status, null);
  const records = coordinationRecords(place.root);
  for (const args of [OWNER_ARGS, OTHER_LANE]) {
    const { r, line, before, after } = duplicate(place, args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual({ end: line?.end, reason: line?.reason }, REFUSED);
    assert.deepEqual(after, before);
  }
  assert.deepEqual(
    coordinationRecords(place.root).slice(0, records.length),
    records,
  );
});

test("a coordination record no merge account wrote grants nothing, though the scripted claim would win", () => {
  const place = setUp(implementReplies(), IMPLEMENTOR_SESSION);
  // A well-formed owner confirmation for a request no one made, written by
  // an account the pipeline doesn't trust.
  const confirm = {
    version: 1,
    scope: '["o/r","main","issue",7,"agent/issue-7"]',
    operation: randomUUID(),
    kind: "confirm",
    request: FORGED_ID - 1,
    instance: randomUUID(),
  };
  const forged = {
    refs: {},
    commits: {},
    comments: [
      Object.fromEntries([
        ["id", FORGED_ID],
        ["node_id", `coordination-${FORGED_ID}`],
        ["issue", ISSUE_NUMBER],
        ["user", { login: "mallory" }],
        ["created_at", "2026-10-18T00:00:00Z"],
        [
          "body",
          `<!-- agent-pipeline:coordination\n${JSON.stringify(confirm)}\n-->`,
        ],
      ]),
    ],
    seq: 900,
    token: 0,
  };
  fs.writeFileSync(
    path.join(place.root, "coordination.json"),
    JSON.stringify(forged),
  );
  const r = runJob(place, OWNER_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const line = JSON.parse(r.stdout);
  assert.equal(line.end, "unclaimed");
  assert.match(line.claimError, UNTRUSTED);
  assert.deepEqual(logOf(place, "ops.log"), []);
  assert.deepEqual(piStarts(place), []);
  assert.deepEqual(checkouts(place), []);
  assert.equal(fs.existsSync(path.join(place.runDir, "job.json")), false);
});
