// @ts-check
// Runs the built workflow as pi-subagents does, with scripted replies, and
// records every launch. One call: runWorkflow({ args, ops, agents }) resolves
// to { trace, summary }.
//
// - `ops` maps an op name (the request's `op`) to the object ops.mjs would
//   print, or to an array of them, used up in order.
// - `agents` maps a launch key without its trailing `-<seq>` (for example
//   `i7-review-correctness`) to a result object such as
//   `{ ok: true, structuredOutput }`, or to an array of them, used up in order.
// - `trace` lists the launches in order: `{ key, agent, label }` for an agent,
//   and `{ key, agent, label, request }` for an ops launch, `label` being the
//   launch's label and `request` the ops launch's parsed JSON request.
//
// A launch with no scripted reply left rejects the run with an error naming
// its key. The workflow's clock is fixed, so every run gives the same trace.
//
// The workflow is built once per test process into its own temporary folder,
// never read from dist/: test files run in parallel, and install.test.mjs
// deletes dist/.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

/**
 * A scripted reply: one object, or an array of them used up in order.
 * @typedef {object | object[]} Scripted
 */
/**
 * A run's inputs: the workflow's args and the replies by op or launch name.
 * @typedef {object} Scenario
 * @property {unknown} args
 * @property {Readonly<Record<string, Scripted>>} [ops]
 * @property {Readonly<Record<string, Scripted>>} [agents]
 */
/**
 * A launch as the workflow asks pi-subagents for it.
 * @typedef {{ key: string, agent: string, label: string, task: string }} LaunchSpec
 */
/**
 * One launch in the trace; `request` is an ops launch's parsed request.
 * @typedef {{ key: string, agent: string, label: string, request?: unknown }} TraceEntry
 */
/** @typedef {{ ops: Map<string, Scripted>, agents: Map<string, Scripted> }} Scripts */
/**
 * What the workflow's body gets as `runs`.
 * @typedef {object} Runs
 * @property {(specs: LaunchSpec[]) => Promise<object[]>} all
 * @property {(spec: LaunchSpec) => Promise<object>} run
 */
/**
 * The AsyncFunction constructor, which compiles the workflow's body.
 * @typedef {new (...source: string[]) => (args: unknown, runs: Runs, date: typeof FixedDate) => Promise<unknown>} AsyncFunctionConstructor
 */

const OPS_AGENT = "issue-pipeline-ops";
// The JSON request between the markers of an ops launch's task.
const OPS_REQUEST = /BEGIN_OPS_REQUEST\n(?<json>.*)\nEND_OPS_REQUEST/u;
// The `-<seq>` the workflow appends to every launch key.
const LAUNCH_SEQUENCE = /-\d+$/u;
// The one instant the workflow's clock reads.
const FIXED_INSTANT = Date.parse("2026-10-15T12:00:00.000Z");
// The one field of an ops request the harness reads.
const OP_FIELD = z.object({ op: z.string() });
/** @type {Readonly<Record<string, string>>} */
const NO_GROUPS = {};

// A Date whose `now()`, and `new Date()` with no arguments, are FIXED_INSTANT.
// The workflow builds a Date from nothing or from one value.
class FixedDate extends Date {
  /** @param {[] | [value: number | string | Date]} parts */
  constructor(...parts) {
    if (parts.length === 0) {
      super(FIXED_INSTANT);
    } else {
      super(...parts);
    }
  }

  /** @override @returns {number} */
  static now() {
    return FIXED_INSTANT;
  }
}

/** @type {AsyncFunctionConstructor} */
const AsyncFunction = Object.getPrototypeOf(async () => null).constructor;
/** @type {string | null} */
let builtBody = null;

// The built workflow's body, built on first use.
/** @returns {string} */
function workflowBody() {
  if (builtBody !== null) {
    return builtBody;
  }
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "issue-pipeline-harness-"),
  );
  process.on("exit", () => fs.rmSync(outDir, { recursive: true, force: true }));
  const script = new URL("../build.ts", import.meta.url).pathname;
  const built = spawnSync(process.execPath, [script, outDir], {
    encoding: "utf8",
  });
  if (built.status !== 0) {
    throw new Error(`workflow harness: build failed\n${built.stderr}`);
  }
  builtBody = fs.readFileSync(path.join(outDir, "workflow.js"), "utf8");
  return builtBody;
}

// A scenario's replies, as a Map whose arrays are the run's own copies.
/** @param {Readonly<Record<string, Scripted>> | undefined} replies @returns {Map<string, Scripted>} */
function scriptOf(replies) {
  /** @type {Map<string, Scripted>} */
  const script = new Map();
  for (const [name, reply] of Object.entries(replies ?? {})) {
    if (Array.isArray(reply)) {
      script.set(name, [...reply]);
    } else {
      script.set(name, reply);
    }
  }
  return script;
}

/** @param {Map<string, Scripted>} script @param {string} name @param {string} key @returns {object} */
function nextReply(script, name, key) {
  const reply = script.get(name);
  if (Array.isArray(reply)) {
    const first = reply.shift();
    if (first === undefined) {
      throw new Error(`workflow harness: the replies for ${key} are used up`);
    }
    return first;
  }
  if (reply === undefined) {
    throw new Error(`workflow harness: no scripted reply for ${key}`);
  }
  return reply;
}

// An ops launch's request, parsed from between the markers of its task.
/** @param {string} key @param {string} task @returns {unknown} */
function opsRequest(key, task) {
  const { json } = OPS_REQUEST.exec(task)?.groups ?? NO_GROUPS;
  if (json === undefined) {
    throw new Error(`workflow harness: no ops request in ${key}`);
  }
  return JSON.parse(json);
}

/** @param {LaunchSpec} spec @param {Scripts} scripts @param {TraceEntry[]} trace @returns {object} */
function launch(spec, scripts, trace) {
  const { key, agent, label } = spec;
  if (agent === OPS_AGENT) {
    const request = opsRequest(key, spec.task);
    trace.push({ key, agent, label, request });
    const { op } = OP_FIELD.parse(request);
    const reply = nextReply(scripts.ops, op, key);
    return { ok: true, key, agent, output: JSON.stringify(reply) };
  }
  trace.push({ key, agent, label });
  const name = key.replace(LAUNCH_SEQUENCE, "");
  return { ...nextReply(scripts.agents, name, key), key, agent };
}

/** @param {Scenario} scenario @returns {Promise<{ trace: TraceEntry[], summary: unknown }>} */
async function runWorkflow(scenario) {
  /** @type {Scripts} */
  const scripts = {
    ops: scriptOf(scenario.ops),
    agents: scriptOf(scenario.agents),
  };
  /** @type {TraceEntry[]} */
  const trace = [];
  /** @type {Runs} */
  // Each launch answers as a promise, so a missing reply rejects the run.
  const runs = {
    all: (specs) =>
      Promise.resolve(specs).then((list) =>
        list.map((spec) => launch(spec, scripts, trace)),
      ),
    run: (spec) =>
      Promise.resolve(spec).then((one) => launch(one, scripts, trace)),
  };
  const run = new AsyncFunction("args", "runs", "Date", workflowBody());
  const summary = await run(structuredClone(scenario.args), runs, FixedDate);
  return { trace, summary };
}

export { runWorkflow };
