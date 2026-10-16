// What a stage's launches promise, read the way the docs describe them: an
// ops request by the op and payload ops reads, and a session by the agent,
// model, reply schema and task it runs with. Launch names, labels and time
// limits are the sweep's internals, so these views leave them out. A driver
// run's trace is read the same way: the requests ops gets, and the agents of
// the sessions that ran, never the launch keys or their order.
import { z } from "zod";

/** @import { JsonSchema } from "../src/workflow/schemas.ts" */
/** @import { Launch, Step } from "../src/workflow/stages/types.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
/** @import { TraceEntry } from "./workflow-harness.mjs" */

// An ops request as ops reads it: its op and the rest of its fields.
const OPS_REQUEST = z.looseObject({ op: z.string() });

/**
 * @typedef {{ op: string, payload: Readonly<Record<string, unknown>> }} OpsRequest
 * @typedef {{ agent: string, model: string, schema: JsonSchema, task: string }} Session
 */

/** @param {Step} step @returns {readonly Launch[]} */
function launched(step) {
  if (step.done) {
    throw new Error("the step ended instead of launching");
  }
  return step.launches;
}

// `launches` as ops requests, in order; throws at a session.
/** @param {readonly Launch[]} launches @returns {OpsRequest[]} */
function asRequests(launches) {
  return launches.map((launch) => {
    if (launch.kind !== "op") {
      throw new Error(`expected an ops request, got session ${launch.label}`);
    }
    return { op: launch.op, payload: launch.payload };
  });
}

// The ops requests `step` makes, in order; throws if it launches a session.
/** @param {Step} step @returns {OpsRequest[]} */
function opsRequests(step) {
  return asRequests(launched(step));
}

// `launches` as sessions, in order; throws at an ops request.
/** @param {readonly Launch[]} launches @returns {Session[]} */
function asSessions(launches) {
  return launches.map((launch) => {
    if (launch.kind !== "child") {
      throw new Error(`expected a session, got ops request ${launch.op}`);
    }
    const { agent, model, schema, task } = launch;
    return { agent, model, schema, task };
  });
}

// The sessions `step` launches, in order; throws if it makes an ops request.
/** @param {Step} step @returns {Session[]} */
function sessions(step) {
  return asSessions(launched(step));
}

// The first request for `op` in a driver run's trace, as ops reads it.
/** @param {readonly TraceEntry[]} trace @param {string} op @returns {Readonly<Record<string, unknown>>} */
function requestFor(trace, op) {
  for (const { request } of trace) {
    if (request !== undefined) {
      const parsed = OPS_REQUEST.parse(request);
      if (parsed.op === op) {
        return parsed;
      }
    }
  }
  throw new Error(`the sweep made no ${op} request`);
}

// The issue's state as the run's release request saved it.
/** @param {readonly TraceEntry[]} trace @returns {IssueState} */
function releasedState(trace) {
  const { state } = requestFor(trace, "release");
  return /** @type {IssueState} */ (state);
}

// The agents of the sessions a driver run launched, in order.
/** @param {readonly TraceEntry[]} trace @returns {string[]} */
function sessionAgents(trace) {
  return trace
    .filter(({ request }) => request === undefined)
    .map(({ agent }) => agent);
}

export {
  asRequests,
  asSessions,
  opsRequests,
  releasedState,
  requestFor,
  sessionAgents,
  sessions,
};
