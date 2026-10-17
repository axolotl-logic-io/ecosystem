// @ts-check
// The runs the rate-limit deferral tests (`rate-limit-defers`) drive through
// workflow-harness.mjs: the errors a provider's rate limit and overload give
// a session, one run of issue #7 from a claim, and what the run did.
import { runWorkflow } from "./workflow-harness.mjs";
import {
  ISSUE,
  ROUTINE_OPS,
  sweepReply,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { SweepSummary } from "../src/workflow/stages/types.ts" */
/** @import { Scripted, TraceEntry } from "./workflow-harness.mjs" */

// The error pi gave the sessions of #303, #304 and #316 at 01:02Z.
const COOLING_DOWN = {
  ok: false,
  error:
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-5-5 are cooling down via provider claude"}}',
};
const OVERLOADED = {
  ok: false,
  error:
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
};
const TIMED_OUT = { ok: false, error: "the session timed out" };
// The log line of a deferral on a rate limit.
const RATE_LIMIT_LINE = /deferred: .* on a rate limit; will retry next sweep$/u;

// A run of issue #7 claimed with `claim`, with the given ops and agents.
/**
 * @param {object} claim
 * @param {Record<string, Scripted>} agents
 * @param {Record<string, Scripted>} [ops]
 * @returns {ReturnType<typeof runWorkflow>}
 */
function issueRun(claim, agents, ops = {}) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config: { maxSpawnsPerRun: 40 } }),
      claim,
      ...ops,
    },
    agents,
  });
}

/** @param {readonly TraceEntry[]} trace @returns {string[]} */
function opsOf(trace) {
  return trace.flatMap(({ request }) => {
    if (request === undefined) {
      return [];
    }
    return [/** @type {{ op: string }} */ (request).op];
  });
}

/** @param {unknown} summary @returns {{ stage: string | null, outcome: string }} */
function itemOf(summary) {
  const [item] = /** @type {SweepSummary} */ (summary).items;
  if (item === undefined) {
    throw new Error("the summary has no item");
  }
  return { stage: item.stage, outcome: item.outcome };
}

export {
  COOLING_DOWN,
  issueRun,
  itemOf,
  OVERLOADED,
  opsOf,
  RATE_LIMIT_LINE,
  TIMED_OUT,
};
