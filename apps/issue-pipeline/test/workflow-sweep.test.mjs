// The sweep's driver (src/workflow/sweep.ts), run directly with a fixed clock
// and scripted raw results, as workflow.js runs it: every batch it asks for is
// answered in order until it asks for none.
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

/** @import { LaunchSpec } from "../src/workflow/launches.ts" */
/** @import { SweepSummary } from "../src/workflow/stages/types.ts" */
/** @import { SweepArgs } from "../src/workflow/sweep-config.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
/**
 * An ops request as a spec's task frames it, with the fields the tests read.
 * @typedef {{ op: string, state?: IssueState, reason?: string, detail?: string, nextStep?: string | null, code?: string | null }} OpsRequest
 */
/**
 * A sweep run to its end: its batches of specs, their keys, and its summary.
 * @typedef {{ batches: LaunchSpec[][], keys: string[], summary: SweepSummary }} SweepRun
 */

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
const TARGET_KEYS = new Set(["only", "takeStopped"]);
// An implementer that always runs out of room.
const HANDOFF = replyWith({
  status: "handoff",
  summary: "Half done.",
  prTitle: "",
  prBody: "",
  testsAdded: [],
});

// The ops request `spec` frames, or null for a session's spec.
/** @param {LaunchSpec} spec @returns {OpsRequest | null} */
function requestOf(spec) {
  const match = OPS_REQUEST.exec(spec.task);
  if (match === null) {
    return null;
  }
  const { json = "" } = match.groups ?? {};
  return JSON.parse(json);
}

// The keys of the first sweep request for `args` that name its target.
/** @param {Partial<SweepArgs>} args @returns {Record<string, unknown>} */
function targetOf(args) {
  const [spec] = startSweep({ ...ARGS, ...args }, CLOCK).next([]);
  if (spec === undefined) {
    throw new Error("the sweep launched nothing");
  }
  const request = requestOf(spec);
  if (request === null) {
    throw new Error("the sweep's first launch is not an ops request");
  }
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => TARGET_KEYS.has(key)),
  );
}

// The raw result pi-subagents would give `spec`: an ops child printing the
// scripted reply for its op, or the scripted reply for the session's key.
/**
 * @param {LaunchSpec} spec
 * @param {Record<string, unknown>} ops
 * @param {Record<string, object>} agents
 * @returns {object}
 */
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
/**
 * @param {{ args?: SweepArgs, ops: Record<string, unknown>, agents?: Record<string, object> }} run
 * @returns {SweepRun}
 */
function drive({ args = ARGS, ops, agents = {} }) {
  const sweep = startSweep(args, CLOCK);
  /** @type {LaunchSpec[][]} */
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
/**
 * @param {object} claim
 * @param {object} [config]
 * @param {number[]} [parents]
 * @returns {Record<string, unknown>}
 */
function opsFor(claim, config = {}, parents = []) {
  return {
    ...ROUTINE_OPS,
    sweep: sweepReply({ items: [ISSUE], config, parents }),
    claim,
  };
}

// The held lines in the state the run releases.
/** @param {LaunchSpec[][]} batches @returns {string[]} */
function heldLines(batches) {
  const release = batches
    .flat()
    .map(requestOf)
    .find((r) => r?.op === "release");
  const log = release?.state?.log ?? [];
  return log.filter((line) => HELD.test(line));
}

test("the driver asks for the sweep op first, keyed by the clock's sweep", () => {
  const sweep = startSweep({ ...ARGS, issue: "7" }, CLOCK);
  const [spec] = sweep.next([]);
  assert.ok(spec);
  assert.equal(spec.key, "sweep-1");
  assert.deepEqual(requestOf(spec), {
    op: "sweep",
    config: ARGS.config,
    sweepId: "s1",
    lane: "lane-a",
    only: 7,
  });
});

test("takeStopped reaches the sweep op", () => {
  assert.deepEqual(targetOf({ issue: "7", takeStopped: true }), {
    only: 7,
    takeStopped: true,
  });
  assert.deepEqual(targetOf({ issue: "7", takeStopped: "yes" }), { only: 7 });
  assert.deepEqual(targetOf({ issue: "7" }), { only: 7 });
  assert.deepEqual(targetOf({ takeStopped: true }), {});
});

test("a named sweep left stopped ends cleanly", () => {
  const stopped = { issue: 7, label: "agent:stopped-budget" };
  const { keys, summary } = drive({
    args: { ...ARGS, issue: "7" },
    ops: { ...ROUTINE_OPS, sweep: { ...sweepReply(), stopped } },
  });
  assert.deepEqual(keys, ["sweep-1", "cleanup-2"]);
  assert.deepEqual(summary.items, [
    {
      issue: 7,
      pr: null,
      stage: null,
      outcome: "left-stopped",
      reason: "agent:stopped-budget",
      allocatedTokens: null,
      rebaseAllocatedTokens: null,
    },
  ]);
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
  const save = batches[2]?.[0];
  assert.ok(save);
  assert.equal(requestOf(save)?.state?.stage, "review");
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
  const stopSpec = batches.at(-2)?.[0];
  assert.ok(stopSpec);
  const stop = requestOf(stopSpec);
  assert.ok(stop);
  assert.equal(
    stop.reason,
    "implementation did not finish within its sessions",
  );
  assert.equal(stop.detail, "");
  assert.equal(stop.nextStep, null);
  assert.equal(stop.code, null);
  assert.equal(summary.items[0]?.reason, stop.reason);
});

test("the driver never asks for an empty batch, and ends with none", () => {
  const failed = drive({ ops: opsFor({ ok: false, error: "locked" }) });
  const waiting = drive({ ops: opsFor({ ok: true, waiting: "answer" }) });
  const runs = [
    drive({ ops: { sweep: sweepReply() } }),
    failed,
    drive({ ops: opsFor(claimAt("triage"), { maxSpawnsPerRun: 10 }) }),
    waiting,
  ];
  for (const { batches } of runs) {
    assert.ok(batches.every((batch) => batch.length > 0));
  }
  const unclaimed = ["sweep-1", "i7-claim-2", "cleanup-3"];
  assert.deepEqual(failed.keys, unclaimed);
  assert.equal(failed.summary.items[0]?.outcome, "claim-failed");
  assert.deepEqual(waiting.keys, unclaimed);
  assert.equal(waiting.summary.items[0]?.outcome, "waiting-for-answer");
});

test("the summary is ready only once the sweep is finished", () => {
  const sweep = startSweep(ARGS, CLOCK);
  sweep.next([]);
  assert.throws(() => sweep.summary(), NOT_FINISHED);
});
