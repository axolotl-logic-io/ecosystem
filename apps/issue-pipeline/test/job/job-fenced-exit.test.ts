// Fenced exit (#170), through the real job against the private fake GitHub
// (fake-job-coordination.ts) and a local origin. A job that lost the issue
// makes zero exit effects: no patch, reset, exit push or removal. A job that
// ends cleanly with no patches keeps both its lane slot and its ownership
// while a registered consumer still needs the slot: the run exiting, or
// its patch list being empty, releases neither.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { IMPLEMENTOR_SESSION, implementReplies } from "../job-fixtures.ts";
import { coordinationRecords } from "./fake-job-coordination.ts";
import type { OpsLine, Place } from "./job-test-kit.ts";
import { logOf, piStarts, runJob, setUp } from "./job-test-kit.ts";

const ARGS = ["--stage", "implement", "--lane", "L"];
const UNTOUCHED = /checkout left untouched at .* for reconciliation/u;
const HELD = /job: execution held: /u;
const CONSUMED =
  /execution held: the lane slot still has registered consumers: /u;

// Returns the coordination records' kinds
function kinds(place: Place): string[] {
  return coordinationRecords(place.root).map(({ kind }) => kind);
}

// Returns the job's code checkout
function checkoutOf(place: Place): string {
  return path.join(place.root, "work", "o__r", "jobs", "issue-7-implement");
}

// Returns the origin's refs
function originRefs(place: Place): string {
  const r = spawnSync("git", ["-C", place.origin, "show-ref"], {
    encoding: "utf8",
  });
  return r.stdout;
}

// Returns the lane slot store's path
function storeOf(place: Place): string {
  return path.join(place.root, "runs", "o__r", "lane-slots.json");
}

test("a job that lost the issue before teardown saves, resets, pushes and removes nothing", () => {
  const replies = implementReplies();
  const place = setUp(
    {
      ...replies,
      claim: { ...replies.claim, successor: "with-work" },
      "exit-push": { ok: true, git: true },
    },
    IMPLEMENTOR_SESSION,
  );
  const refs = originRefs(place);
  const r = runJob(place, ARGS);
  assert.equal(r.status, 1);
  assert.match(r.stderr, UNTOUCHED);
  assert.match(r.stderr, HELD);
  assert.deepEqual(piStarts(place), []);
  assert.equal(
    logOf<OpsLine>(place, "ops.log").some(({ op }) => op === "exit-push"),
    false,
  );
  assert.equal(fs.existsSync(path.join(place.runDir, "dropped")), false);
  assert.equal(fs.existsSync(path.join(place.runDir, "recovery")), false);
  const repo = path.join(checkoutOf(place), "repo");
  assert.equal(
    fs.readFileSync(path.join(repo, "uncommitted.txt"), "utf8"),
    "local edit\n",
  );
  const subject = spawnSync("git", ["-C", repo, "log", "-1", "--format=%s"], {
    encoding: "utf8",
  });
  assert.equal(subject.stdout.trim(), "stale local work");
  assert.equal(originRefs(place), refs);
  const records = coordinationRecords(place.root);
  const successor = records.findLast(
    (row) => row.kind === "request" && row.identity.lane === "successor",
  );
  assert.ok(successor);
  assert.deepEqual(
    records.slice(records.indexOf(successor)).map(({ kind }) => kind),
    ["request", "confirm"],
  );
});

for (const consumer of ["a secondary checkout", "a pending setup"]) {
  test(`${consumer} keeps the lane slot and ownership after a clean exit with no patches`, () => {
    const place = setUp(implementReplies(), IMPLEMENTOR_SESSION, {
      laneSlots: 1,
    });
    const other = path.join(place.tmp, "secondary");
    spawnSync("git", ["init", "-q", other]);
    const lease: {
      issue: number;
      slot: number;
      checkouts: string[];
      pendingSetup: string[];
    } = { issue: 7, slot: 1, checkouts: [other], pendingSetup: [] };
    if (consumer === "a pending setup") {
      lease.pendingSetup = [other];
    }
    const store = { leases: [lease], prunedAt: null };
    fs.mkdirSync(path.dirname(storeOf(place)), { recursive: true });
    fs.writeFileSync(storeOf(place), JSON.stringify(store));
    const r = runJob(place, ARGS);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).end, "next");
    assert.match(r.stderr, CONSUMED);
    assert.equal(fs.existsSync(path.join(place.runDir, "dropped")), false);
    assert.equal(fs.existsSync(checkoutOf(place)), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(storeOf(place), "utf8")),
      store,
    );
    assert.deepEqual(kinds(place), ["request", "confirm"]);
    const ops = logOf(place, "ops.log").length;
    const next = runJob(place, ARGS);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(
      JSON.parse(next.stdout).reason,
      "another invocation owns the issue",
    );
    assert.equal(logOf(place, "ops.log").length, ops);
  });
}
