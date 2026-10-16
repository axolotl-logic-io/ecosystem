// The sweep's launch specs (src/workflow/launches.ts) and the reading of
// their results (src/workflow/launch-results.ts): the ops request's framing,
// the comments riding along, the child spec, ops reply parsing and the tokens
// a session reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchResults, parseOps } from "../src/workflow/launch-results.ts";
import { childSpec, opsSpec } from "../src/workflow/launches.ts";

/** @import { OpsSpec } from "../src/workflow/launches.ts" */
/** @import { LaunchMeta } from "../src/workflow/signing.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
/** @import { ChildLaunch, OpLaunch } from "../src/workflow/stages/types.ts" */

const FRAME = { config: "/w/repos/o__r.json", sweepId: "s1", lane: "lane-a" };
const OPS_REQUEST = /^BEGIN_OPS_REQUEST\n(?<json>.*)\nEND_OPS_REQUEST$/u;
const SIGNED = { role: "triage", agent: null, model: null, run: null };
/** @type {OpLaunch} */
const SAVE = {
  kind: "op",
  name: "i7-save",
  op: "save-state",
  payload: { number: 7, state: { stage: "spec" } },
};
const TOKEN_BUDGET = 50_000;
/** @type {ChildLaunch} */
const CHILD = {
  kind: "child",
  name: "triage",
  label: "Triage #7",
  agent: "issue-pipeline-writer",
  model: "anthropic/claude-opus-5-5",
  schema: { type: "object" },
  minutes: 0,
  budgetRole: "triage",
  tokenBudget: TOKEN_BUDGET,
  task: "Triage.",
};
const SEQ = 4;
const OUTPUT_TAIL = 500;
// More minutes than any default, asked for by a launch.
const LONG_MINUTES = 60;
// The state's tokens before a session, and after it reports input 1, output
// 2, cache reads 3 and cache writes 4: the cache reads don't count.
const TOKENS_BEFORE = 10;
const TOKENS_AFTER = 17;
const USAGE = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
const WHERE = { n: 7, worktree: "/w/work/o__r/issue-7" };

/**
 * The JSON request an ops spec's task frames.
 * @param {OpsSpec} spec
 * @returns {{ comments?: unknown }}
 */
function requestOf(spec) {
  const { json = "" } = OPS_REQUEST.exec(spec.task)?.groups ?? {};
  return JSON.parse(json);
}

// An issue at triage with no tokens reported yet.
/** @returns {IssueState} */
function triageState() {
  return { stage: "triage", depth: 0, findings: [] };
}

test("a failed ops child is an error with its detail", () => {
  assert.deepEqual(parseOps({ ok: false, error: "timed out" }), {
    ok: false,
    error: "ops child failed: timed out",
  });
  assert.deepEqual(parseOps({ ok: false }), {
    ok: false,
    error: "ops child failed: no detail",
  });
});

test("the reply is the last JSON line of the output", () => {
  const output = 'log line\n{"ok":false}\n{"ok":true,"n":1}\n  \n';
  assert.deepEqual(parseOps({ ok: true, output }), { ok: true, n: 1 });
});

test("a broken last JSON line ends the scan", () => {
  const output = '{"ok":true}\n{"ok":tr';
  assert.deepEqual(parseOps({ ok: true, output }), {
    ok: false,
    error: `ops reply was not JSON: ${output}`,
  });
});

test("output with no JSON keeps its last 500 characters", () => {
  const output = "ab".repeat(OUTPUT_TAIL);
  const { error } = parseOps({ ok: true, output });
  assert.equal(error, `ops reply was not JSON: ${output.slice(-OUTPUT_TAIL)}`);
});

test("an ops request carries the sweep's frame, the op and its payload", () => {
  const request = requestOf(opsSpec(FRAME, SEQ, SAVE, null));
  assert.deepEqual(request, { op: "save-state", ...FRAME, ...SAVE.payload });
});

test("queued comments ride along only on a request for their issue", () => {
  const comment = { number: 42, by: SIGNED, body: "Hi." };
  const outbox = { number: 7, comments: [comment] };
  /** @type {OpLaunch} */
  const other = { ...SAVE, payload: { number: 5 } };
  assert.equal(requestOf(opsSpec(FRAME, 1, other, outbox)).comments, undefined);
  assert.deepEqual(outbox.comments, [comment]);
  const request = requestOf(opsSpec(FRAME, 2, SAVE, outbox));
  assert.deepEqual(request.comments, [comment]);
  assert.deepEqual(outbox.comments, []);
  assert.equal(
    requestOf(opsSpec(FRAME, SEQ, SAVE, outbox)).comments,
    undefined,
  );
});

test("an ops request that asks for more minutes gets them, with no earlier silence alert", () => {
  const plain = opsSpec(FRAME, 1, SAVE, null);
  const long = opsSpec(FRAME, 1, { ...SAVE, minutes: LONG_MINUTES }, null);
  assert.ok(long.timeoutMs > plain.timeoutMs);
  for (const spec of [plain, long]) {
    assert.deepEqual(spec.control, { needsAttentionAfterMs: spec.timeoutMs });
  }
});

test("a session runs in the worktree with the bridge off, keyed by its issue", () => {
  /** @type {Record<string, LaunchMeta>} */
  const meta = {};
  const { timeoutMs, ...spec } = childSpec(SEQ, WHERE, CHILD, meta);
  assert.ok(timeoutMs > 0);
  assert.deepEqual(spec, {
    key: "i7-triage-4",
    label: "Triage #7",
    agent: "issue-pipeline-writer",
    model: "anthropic/claude-opus-5-5",
    cwd: "/w/work/o__r/issue-7",
    task: "Triage.",
    outputSchema: { type: "object" },
    budgetRole: "triage",
    tokenBudget: TOKEN_BUDGET,
    intercomBridge: { mode: "off" },
  });
  assert.deepEqual(meta, {
    "i7-triage-4": {
      agent: "issue-pipeline-writer",
      model: "anthropic/claude-opus-5-5",
    },
  });
});

test("only a writer's session waives pi-subagents' acceptance", () => {
  const reader = childSpec(SEQ, WHERE, CHILD, {});
  const writer = childSpec(
    SEQ,
    WHERE,
    { ...CHILD, writer: true, minutes: LONG_MINUTES },
    {},
  );
  assert.equal(reader.acceptance, undefined);
  assert.equal(writer.acceptance?.level, "none");
  assert.ok(writer.timeoutMs > reader.timeoutMs);
});

test("a session's reported tokens, less its cache reads, add to the state, and its result is signed", () => {
  /** @type {Record<string, LaunchMeta>} */
  const meta = {};
  const spec = childSpec(SEQ, WHERE, CHILD, meta);
  const st = { ...triageState(), reportedTokens: TOKENS_BEFORE };
  const raw = {
    ok: true,
    key: spec.key,
    structuredOutput: { decision: "ready" },
    results: [{ usage: USAGE }],
  };
  const okReply = { ok: true, output: '{"ok":true}' };
  const results = launchResults([CHILD, SAVE], [raw, okReply], st, meta);
  assert.equal(st.reportedTokens, TOKENS_AFTER);
  assert.deepEqual(results, [
    {
      kind: "child",
      ok: true,
      structuredOutput: { decision: "ready" },
      error: null,
      by: {
        role: "triage",
        agent: "issue-pipeline-writer",
        model: "claude-opus-5-5",
        run: "i7-triage-4",
      },
    },
    { kind: "op", reply: { ok: true } },
  ]);
});

test("a session that reports no usage leaves the state's tokens alone", () => {
  const st = triageState();
  launchResults([CHILD], [{ ok: false, error: "boom" }], st, {});
  assert.equal(Object.hasOwn(st, "reportedTokens"), false);
});
