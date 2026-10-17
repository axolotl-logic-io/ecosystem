// @ts-check
// Every edge of the spec writer role's Lifecycle table (#333; the wiki's
// Pipeline-Roles-Spec-Writer): a state, its result and the result's reply,
// what `data` held, and the next state, its effect's kind and op, check or
// session name (`check:reset`) or its end, and what `data` holds after.
import { READINGS, replyOf } from "./spec-writer-role-test-kit.mjs";

/** @import { End, Effect } from "../src/roles/machine.ts" */
/** @import { SpecData, SpecState } from "../src/roles/spec-writer/locate.ts" */
/** @import { SpecResult } from "../src/roles/spec-writer/machine.ts" */
/** @import { SpecReading, SpecWriterReply } from "../src/roles/spec-writer/reply.ts" */

const ISSUE = 7;
const SPLIT_TOO_SMALL = "the spec writer's split had fewer than 2 parts";

/**
 * @typedef {object} EdgeCase
 * @property {SpecState} at the state
 * @property {SpecResult} result its result
 * @property {unknown} [reply] the result's reply
 * @property {Partial<SpecData>} [data] what `data` holds before
 * @property {SpecState} next the next state
 * @property {string | End} effect the next effect's kind and name, as
 *   `op:<op>`, `check:<check>` or `session:<name>`, or its end
 * @property {Partial<SpecData>} [changes] what `data` holds after
 */

/** @param {string} reason @param {string | null} detail @returns {End} the stop with `reason` */
function stoppedWith(reason, detail) {
  const payload = { number: ISSUE, code: "error", reason, detail };
  return { kind: "stopped", code: "error", after: { op: "stop", payload } };
}

const { ready, refused } = READINGS;
/** @param {SpecReading} reading @returns {SpecWriterReply | null} its reply, when it is ready */
function readyOf(reading) {
  if (reading.kind === "ready") {
    return reading.reply;
  }
  return null;
}

const readyReply = readyOf(ready);

/** @type {EdgeCase[]} */
const EDGES = [
  { at: "claim", result: "ok", next: "checkout", effect: "check:checkout" },
  {
    at: "claim",
    result: "not-ours",
    next: "released",
    effect: { kind: "released" },
  },
  {
    at: "checkout",
    result: "ok",
    reply: { startSha: "a1", startWikiSha: "w1" },
    next: "session",
    effect: "session:spec",
    changes: { startSha: "a1", startWikiSha: "w1", attempts: 1 },
  },
  {
    at: "session",
    result: "replied",
    reply: replyOf(),
    next: "check-reply",
    effect: "check:check-reply",
    changes: { reply: ready },
  },
  {
    at: "session",
    result: "failed",
    reply: "boom",
    next: "retry",
    effect: "check:retry",
    changes: { checkOutput: "boom" },
  },
  {
    at: "check-reply",
    result: "ready",
    data: { reply: ready },
    next: "check-commits",
    effect: "check:spec-tests-check",
    changes: {
      spec: readyReply?.spec,
      files: readyReply?.files,
      interfaces: readyReply?.interfaces,
      noTestsReason: null,
    },
  },
  {
    at: "check-reply",
    result: "no-work",
    next: "confirm-no-work",
    effect: "check:confirm-no-work",
  },
  {
    at: "check-reply",
    result: "needs-info",
    next: "reset",
    effect: "check:reset",
  },
  { at: "check-reply", result: "split", next: "reset", effect: "check:reset" },
  {
    at: "check-reply",
    result: "refused",
    next: "reset",
    effect: "check:reset",
  },
  {
    at: "check-reply",
    result: "bad",
    reply: "no marker",
    next: "retry",
    effect: "check:retry",
    changes: { checkOutput: "no marker" },
  },
  {
    at: "check-commits",
    result: "pass",
    reply: { sha: "t1" },
    next: "publish-spec",
    effect: "check:publish-spec",
    changes: { specTestsSha: "t1" },
  },
  {
    at: "check-commits",
    result: "fail",
    reply: "lint",
    next: "retry",
    effect: "check:retry",
    changes: { checkOutput: "lint" },
  },
  {
    at: "confirm-no-work",
    result: "pass",
    next: "reset",
    effect: "check:reset",
  },
  {
    at: "confirm-no-work",
    result: "fail",
    reply: "red",
    next: "retry",
    effect: "check:retry",
    changes: { checkOutput: "red" },
  },
  {
    at: "retry",
    result: "ok",
    data: { attempts: 1 },
    next: "session",
    effect: "session:spec",
    changes: { attempts: 2 },
  },
  {
    at: "reset",
    result: "needs-info",
    data: { reply: READINGS["needs-info"] },
    next: "ask",
    effect: "op:ask",
  },
  {
    at: "reset",
    result: "split",
    data: { reply: READINGS.split },
    next: "split",
    effect: "op:split",
  },
  {
    at: "reset",
    result: "no-work",
    data: { reply: READINGS["no-work"] },
    next: "stop-no-work",
    effect: "op:post",
  },
  {
    at: "reset",
    result: "refused",
    data: { reply: refused },
    next: "split-refused",
    effect: stoppedWith(SPLIT_TOO_SMALL, null),
  },
  {
    at: "ask",
    result: "ok",
    next: "asked",
    effect: { kind: "saved", stage: "triage" },
  },
  {
    at: "split",
    result: "ok",
    next: "split-opened",
    effect: { kind: "released" },
  },
  {
    at: "stop-no-work",
    result: "ok",
    next: "no-work",
    effect: { kind: "stopped", code: "no-work" },
  },
  {
    at: "publish-spec",
    result: "code",
    reply: { spec: "s", specFile: "/runs/issue-7/spec.md" },
    next: "open-pr",
    effect: "op:start-pr",
    changes: { spec: "s", specFile: "/runs/issue-7/spec.md" },
  },
  {
    at: "publish-spec",
    result: "wiki-only",
    reply: { spec: "s" },
    next: "close-old-pr",
    effect: "check:close-old-pr",
    changes: { spec: "s" },
  },
  {
    at: "open-pr",
    result: "ok",
    next: "pr-opened",
    effect: { kind: "saved", stage: "implement" },
  },
  {
    at: "close-old-pr",
    result: "ok",
    next: "wiki-only",
    effect: { kind: "saved", stage: "review" },
  },
];

/** @param {Effect} effect @returns {string | End} its kind and op, check or session name, as `kind:name`, or its end */
function nameOf(effect) {
  switch (effect.kind) {
    case "op":
      return `op:${effect.op}`;
    case "check":
      return `check:${effect.check}`;
    case "session":
      return `session:${effect.name}`;
    case "end":
      return effect.end;
    default:
      return "";
  }
}

// Each entry state's own effect: no edge leads into `claim`, so the edges
// don't check its kind.
/** @type {[SpecState, string][]} */
const ENTRY_EFFECTS = [
  ["claim", "check:claim"],
  ["open-pr", "op:start-pr"],
  ["close-old-pr", "check:close-old-pr"],
];

export { EDGES, ENTRY_EFFECTS, ISSUE, nameOf, stoppedWith };
