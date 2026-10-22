// @ts-check
// Readers of the call log the reviewer and merge roles' fake context keeps:
// what a role asked for, in which order, and how it ended.
import { z } from "zod";

const PAYLOAD = z.record(z.string(), z.unknown());

/**
 * @typedef {{ kind: "op", name: string, payload: object }
 *   | { kind: "session", spec: import("../../src/job/role-context.ts").SessionSpec }
 *   | { kind: "post", comment: import("../../src/job/role-context.ts").PostedComment }
 *   | { kind: "save", state: import("../../src/state.ts").IssueState }} Call
 */

/** Each call's op name, or its kind for a call that isn't an op. @param {Call[]} calls */
function callNames(calls) {
  return calls.map((call) => {
    if (call.kind === "op") {
      return call.name;
    }
    return call.kind;
  });
}

/** @param {Call[]} calls */
function opNames(calls) {
  return calls.flatMap((call) => {
    if (call.kind === "op") {
      return [call.name];
    }
    return [];
  });
}

/** @param {Call[]} calls @param {string} name */
function opPayloads(calls, name) {
  return calls.flatMap((call) => {
    if (call.kind === "op" && call.name === name) {
      return [PAYLOAD.parse(call.payload)];
    }
    return [];
  });
}

/**
 * The result-check targets before security preparation or completion, after
 * any code merge, independent of check order and intervening reads.
 * @param {Call[]} calls
 * @param {"prepare-review" | "finish"} boundary
 */
function checksBefore(calls, boundary) {
  const names = opNames(calls);
  const before = names.indexOf(boundary);
  if (before < 0) {
    throw new Error(`missing ${boundary}`);
  }
  const after = names.lastIndexOf("merge", before) + 1;
  const checks = calls
    .filter((call) => call.kind === "op")
    .slice(after, before);
  return { verify: firstPayload(checks, "verify") };
}

/**
 * The first `name` op's payload, empty when there was none; its keys are
 * read by destructuring.
 * @param {Call[]} calls @param {string} name
 * @returns {Record<string, unknown>}
 */
function firstPayload(calls, name) {
  return opPayloads(calls, name)[0] ?? {};
}

/**
 * Whether the call right before the first `name` op was a current-revision
 * op: the mutation's fresh precondition.
 * @param {Call[]} calls @param {string} name
 */
function freshBefore(calls, name) {
  const names = callNames(calls);
  const at = names.indexOf(name);
  return at > 0 && names[at - 1] === "current-revision";
}

/** @param {Call[]} calls */
function sessionsOf(calls) {
  return calls.flatMap((call) => {
    if (call.kind === "session") {
      return [call.spec];
    }
    return [];
  });
}

/** @param {Call[]} calls */
function postsOf(calls) {
  return calls.flatMap((call) => {
    if (call.kind === "post") {
      return [call.comment];
    }
    return [];
  });
}

/** @param {Call[]} calls */
function savesOf(calls) {
  return calls.flatMap((call) => {
    if (call.kind === "save") {
      return [call.state];
    }
    return [];
  });
}

/**
 * The end's state; throws, failing the test, unless the end is `kind`.
 * @param {import("../../src/job/role-context.ts").RoleEnd} end
 * @param {"next" | "stop" | "ask" | "wait"} kind
 */
function stateOf(end, kind) {
  if (end.kind === "deferred" || end.kind !== kind) {
    throw new Error(`expected a ${kind} end, got ${JSON.stringify(end)}`);
  }
  return end.state;
}

/**
 * A stop's code, or the end's kind for an end that isn't a stop.
 * @param {import("../../src/job/role-context.ts").RoleEnd} end
 */
function endCode(end) {
  if (end.kind === "stop") {
    return end.code;
  }
  return end.kind;
}

export {
  callNames,
  checksBefore,
  endCode,
  firstPayload,
  freshBefore,
  opNames,
  opPayloads,
  postsOf,
  savesOf,
  sessionsOf,
  stateOf,
};
