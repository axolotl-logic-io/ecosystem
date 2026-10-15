// The sweep's driver (src/workflow/sweep.ts), run directly with a fixed clock
// and scripted raw results, as workflow.js's loop runs it: every batch it asks
// for is answered in order until it asks for none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startSweep } from "../src/workflow/sweep.ts";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
} from "./workflow-stages-fixtures.mjs";

const ARGS = { config: "/w/repos/o__r.json", lane: "lane-a" };
const CLOCK = {
  sweepId: "s1",
  now: () => new Date("2026-10-15T12:00:00.000Z"),
};
const OPS_REQUEST = /^BEGIN_OPS_REQUEST\n(?<json>.*)\nEND_OPS_REQUEST$/u;
const HELD = /held at (?<stage>[\w-]+) by the per-run spawn cap/u;
const SEQUENCE = /-\d+$/u;
const PARENT = 5;
const SWEEP_FAILED = /sweep failed: gh is down/u;
const NOT_FINISHED = /only once the sweep is finished/u;
// An implementer that always runs out of room.
const HANDOFF = replyWith({
  status: "handoff",
  summary: "Half done.",
  prTitle: "",
  prBody: "",
  testsAdded: [],
});

function requestOf(spec) {
  const match = OPS_REQUEST.exec(spec.task);
  if (match === null) {
    return null;
  }
  return JSON.parse(match.groups.json);
}

// The raw result pi-subagents would give `spec`: an ops child printing the
// scripted reply for its op, or the scripted reply for the session's key.
function rawResult(spec, ops, agents) {
  const request = requestOf(spec);
  if (request !== null) {
    const reply = ops[request.op] ?? { ok: false, error: "unscripted" };
    return { ok: true, key: spec.key, output: JSON.stringify(reply) };
  }
  const reply = agents[spec.key.replace(SEQUENCE, "")];
  return { ok: false, error: "unscripted", ...reply, key: spec.key };
}

// Runs a sweep to its end. Returns its batches of specs and its summary.
function drive({ args = ARGS, ops, agents = {} }) {
  const sweep = startSweep(args, CLOCK);
  const batches = [];
  let specs = sweep.next([]);
  while (specs.length > 0) {
    batches.push(specs);
    specs = sweep.next(specs.map((spec) => rawResult(spec, ops, agents)));
  }
  return {
    batches,
    keys: batches.flat().map(({ key }) => key),
    summary: sweep.summary(),
  };
}

// The ops of a run of issue #7 claimed with `claim`, under `config`.
function opsFor(claim, config = {}, parents = []) {
  return {
    ...ROUTINE_OPS,
    sweep: sweepReply({ items: [ISSUE], config, parents }),
    claim,
  };
}

// The held lines in the state the run releases.
function heldLines(batches) {
  const release = batches
    .flat()
    .map(requestOf)
    .find((r) => r?.op === "release");
  return release.state.log.filter((line) => HELD.test(line));
}

test("the driver asks for the sweep op first, keyed by the clock's sweep", () => {
  const sweep = startSweep({ ...ARGS, issue: "7" }, CLOCK);
  const [spec] = sweep.next([]);
  assert.equal(spec.key, "sweep-1");
  assert.deepEqual(requestOf(spec), {
    op: "sweep",
    config: ARGS.config,
    sweepId: "s1",
    lane: "lane-a",
    only: 7,
  });
});

test("a failed sweep reply rejects the run", () => {
  const sweep = startSweep(ARGS, CLOCK);
  sweep.next([]);
  const failed = { ok: true, output: '{"ok":false,"error":"gh is down"}' };
  assert.throws(() => sweep.next([failed]), SWEEP_FAILED);
});

test("a stage is held when it and the reserve pass the cap, logged once", () => {
  // Triage needs 4 spawns: 2 launched + 4 + a reserve of 3 for the issue and
  // 2 (one of them the cleanup) passes 10.
  const { keys, batches } = drive({
    ops: opsFor(claimAt("triage"), { maxSpawnsPerRun: 10 }),
  });
  assert.deepEqual(keys, [
    "sweep-1",
    "i7-claim-2",
    "i7-release-3",
    "cleanup-4",
  ]);
  assert.deepEqual(heldLines(batches), [
    "2026-10-15T12:00Z held at triage by the per-run spawn cap; continues next sweep",
  ]);
});

test("the reserve keeps a spawn for each parent to close", () => {
  // With no parent, triage fits under 11 and begins.
  const fitting = drive({
    ops: opsFor(claimAt("triage"), { maxSpawnsPerRun: 11 }),
  });
  assert.notEqual(fitting.keys[2], "i7-release-3");
  const { keys } = drive({
    ops: {
      ...opsFor(claimAt("triage"), { maxSpawnsPerRun: 11 }, [PARENT]),
      "close-parent": { ok: true },
    },
  });
  assert.deepEqual(keys, [
    "sweep-1",
    "i7-claim-2",
    "p5-close-3",
    "i7-release-4",
    "cleanup-5",
  ]);
});

test("review's state is saved before it first begins, even when held", () => {
  const claim = claimAt("review", { pr: 42, headSha: "aaaaaaa" });
  const { keys, batches } = drive({
    ops: opsFor(claim, { maxSpawnsPerRun: 14 }),
  });
  assert.deepEqual(keys, [
    "sweep-1",
    "i7-claim-2",
    "i7-save-3",
    "i7-release-4",
    "cleanup-5",
  ]);
  assert.equal(requestOf(batches[2][0]).state.stage, "review");
  assert.equal(heldLines(batches).length, 1);
});

test("an implementer still unfinished after both passes is stopped", () => {
  const claim = claimAt("implement", {
    plan: "Change src/a.ts.",
    spec: "## Behaviour\n\n1. src/a.ts does the thing.",
    pr: 42,
    headSha: "aaaaaaa",
    continuations: -1,
  });
  const { keys, batches, summary } = drive({
    ops: opsFor(claim),
    agents: { "i7-implement": HANDOFF },
  });
  assert.deepEqual(keys, [
    "sweep-1",
    "i7-claim-2",
    "i7-save-3",
    "i7-implement-4",
    "i7-implement-5",
    "i7-stop-6",
    "cleanup-7",
  ]);
  const stop = requestOf(batches.at(-2)[0]);
  assert.equal(
    stop.reason,
    "implementation did not finish within its sessions",
  );
  assert.equal(stop.detail, "");
  assert.equal(stop.nextStep, null);
  assert.equal(stop.code, null);
  assert.equal(summary.items[0].reason, stop.reason);
});

test("the driver never asks for an empty batch, and ends with none", () => {
  const runs = [
    drive({ ops: { sweep: sweepReply() } }),
    drive({ ops: opsFor({ ok: false, error: "locked" }) }),
    drive({ ops: opsFor(claimAt("triage"), { maxSpawnsPerRun: 10 }) }),
  ];
  for (const { batches } of runs) {
    assert.ok(batches.every((batch) => batch.length > 0));
  }
  assert.deepEqual(runs[1].keys, ["sweep-1", "i7-claim-2", "cleanup-3"]);
  assert.equal(runs[1].summary.items[0].outcome, "claim-failed");
});

test("the summary is ready only once the sweep is finished", () => {
  const sweep = startSweep(ARGS, CLOCK);
  sweep.next([]);
  assert.throws(() => sweep.summary(), NOT_FINISHED);
});
