// The stage job's raw results: an ops child's exit and a pi session's RPC
// events, mapped to the shapes launch-results.ts reads unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { opsRaw, sessionRaw } from "../src/job/raw-results.ts";
import { launchResults, parseOps } from "../src/workflow/launch-results.ts";

/** @import { ProcessExit } from "../src/job/raw-results.ts" */
/** @import { ChildLaunch, ChildResult, LaunchResult } from "../src/workflow/stages/types.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
/** @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Usage */

const LAUNCH = { key: "i7-spec-4", agent: "issue-pipeline-specifier" };
/** @type {ChildLaunch} */
const SPEC_LAUNCH = {
  kind: "child",
  name: "spec",
  role: "specifier",
  label: "spec #7",
  agent: LAUNCH.agent,
  model: "anthropic/claude-opus-5-5",
  schema: { type: "object" },
  minutes: 30,
  tokenBudget: 80_000,
  task: "Write the spec.",
};

/**
 * @param {number | null} code
 * @param {string} stdout
 * @param {string} [stderr]
 * @param {boolean} [timedOut]
 * @returns {ProcessExit}
 */
function exited(code, stdout, stderr = "", timedOut = false) {
  return { code, stdout, stderr, timedOut };
}

/** @param {object[]} events @returns {string} */
function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** @param {Usage} usage @param {object} [extra] @returns {object} */
function assistantEnd(usage, extra = {}) {
  return {
    type: "message_end",
    message: { role: "assistant", content: [], usage, ...extra },
  };
}

/** @param {object} details @param {boolean} [isError] @returns {object} */
function outputEnd(details, isError = false) {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "structured_output",
    result: { content: [{ type: "text", text: "saved" }], details },
    isError,
  };
}

const USAGE_A = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 };
const USAGE_B = { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 };
const SUM_AB = { input: 105, output: 26, cacheRead: 307, cacheWrite: 48 };
// The tokens the issue had reported before the session.
const EARLIER_TOKENS = 10;
const CONFIG_NOT_FOUND = /boom: config not found/u;
const TIMED_OUT = /timed out/u;

/** @param {Usage} usage @returns {number} */
function tokensOf(usage) {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

// An issue at spec that had reported `reportedTokens` before the session.
/** @param {number} reportedTokens @returns {IssueState} */
function specState(reportedTokens) {
  return {
    stage: "spec",
    depth: 0,
    findings: [],
    allocated: 0,
    reportedTokens,
  };
}

// The one result, a session's.
/** @param {LaunchResult[]} results @returns {ChildResult} */
function childResult([result]) {
  if (result?.kind !== "child") {
    throw new Error("expected one session's result");
  }
  return result;
}

test("an ops child that exits 0 with a JSON line gives its reply", () => {
  const raw = opsRaw(exited(0, 'working\n{"ok":true,"items":[]}\n'));
  assert.deepEqual(parseOps(raw), { ok: true, items: [] });
});

test("an ops child that exits 1 fails with the end of its stderr", () => {
  const raw = opsRaw(exited(1, "", "boom: config not found\n"));
  assert.equal(raw.ok, false);
  assert.equal(raw.error, "boom: config not found");
  const { error } = parseOps(raw);
  assert.match(String(error), CONFIG_NOT_FOUND);
});

test("an ops child stopped by its timeout fails with a timeout message", () => {
  const raw = opsRaw(exited(null, '{"ok":true}', "", true));
  assert.equal(raw.ok, false);
  assert.match(raw.error, TIMED_OUT);
});

test("a session with structured output sums its usage and counts it as reported tokens", () => {
  const details = { decision: "ready", spec: "## Behaviour", questions: [] };
  const stdout = jsonl([
    { type: "session", version: 3, id: "x" },
    { type: "message_end", message: { role: "user", content: "task" } },
    assistantEnd(USAGE_A, { stopReason: "toolUse" }),
    { type: "tool_execution_start", toolName: "structured_output" },
    outputEnd(details),
    assistantEnd(USAGE_B, { stopReason: "stop" }),
    { type: "agent_end", messages: [] },
  ]);
  const raw = sessionRaw(LAUNCH, exited(0, `${stdout}not json\n`));
  assert.equal(raw.ok, true);
  assert.deepEqual(raw.structuredOutput, details);
  assert.equal(raw.key, LAUNCH.key);
  assert.equal(raw.agent, LAUNCH.agent);
  assert.deepEqual(raw.results, [{ usage: SUM_AB }]);
  const st = specState(EARLIER_TOKENS);
  const result = childResult(launchResults([SPEC_LAUNCH], [raw], st, {}));
  assert.equal(result.ok, true);
  assert.deepEqual(result.structuredOutput, details);
  assert.equal(st.reportedTokens, EARLIER_TOKENS + tokensOf(SUM_AB));
});

test("a failed session reports its error and usage, with no structured output", () => {
  const stdout = jsonl([
    outputEnd({ ignored: true }, true),
    assistantEnd(USAGE_A, {
      stopReason: "error",
      errorMessage: "overloaded_error",
    }),
  ]);
  const raw = sessionRaw(LAUNCH, exited(1, stdout, "pi: provider error\n"));
  assert.equal(raw.ok, false);
  assert.equal(raw.error, "overloaded_error");
  assert.equal(raw.structuredOutput, null);
  assert.deepEqual(raw.results, [{ usage: USAGE_A }]);
  const st = specState(0);
  const result = childResult(launchResults([SPEC_LAUNCH], [raw], st, {}));
  assert.equal(result.ok, false);
  assert.equal(result.error, "overloaded_error");
  assert.equal(st.reportedTokens, tokensOf(USAGE_A));
});

test("a session that ends without structured output fails, naming the stderr or the missing output", () => {
  const stdout = jsonl([assistantEnd(USAGE_B, { stopReason: "stop" })]);
  assert.equal(
    sessionRaw(LAUNCH, exited(0, stdout, "warning: slow\n")).error,
    "warning: slow",
  );
  const quiet = sessionRaw(LAUNCH, exited(0, stdout));
  assert.equal(quiet.ok, false);
  assert.equal(quiet.error, "no structured output");
});

test("a session whose prompt pi rejected fails with the response's error", () => {
  const rejected = {
    id: "prompt",
    type: "response",
    command: "prompt",
    success: false,
    error: "Model not found: x/y",
  };
  const raw = sessionRaw(LAUNCH, exited(0, jsonl([rejected])));
  assert.equal(raw.ok, false);
  assert.equal(raw.error, "Model not found: x/y");
});

test("a resumed session adds its earlier usage to its new events'", () => {
  const earlier = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };
  const stdout = jsonl([assistantEnd(usage), outputEnd({ decision: "ready" })]);
  const raw = sessionRaw(LAUNCH, exited(0, stdout), earlier);
  assert.equal(raw.ok, true);
  assert.deepEqual(raw.results[0].usage, {
    input: 11,
    output: 22,
    cacheRead: 33,
    cacheWrite: 44,
  });
});
