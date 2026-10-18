// @ts-check
// Every edge of the implementor's `implement` entry
// (#414; the wiki's Pipeline-Roles-Implementor, "Lifecycle"), as a state,
// a result, the reply and data it is taken with, the next state, its effect
// (an op's, check's or session's name, or the end) and the data it changes.
import {
  BAD_REPLY,
  BLOCKED,
  BLOCKED_REASON,
  CHANGED_NOTHING,
  DONE,
  HANDOFF,
  outOfRoom,
  PUSHED_CODE,
  PUSHED_NONE,
  stoppedWith,
} from "./implementor-role-test-kit.mjs";

/** @import { ImplData, ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { ImplResult } from "../src/roles/implementor/machine.ts" */
/** @import { End } from "../src/roles/machine.ts" */

/**
 * @typedef {object} EdgeCase
 * @property {ImplState} at
 * @property {ImplResult} result
 * @property {unknown} [reply]
 * @property {Partial<ImplData>} [data]
 * @property {ImplState} next
 * @property {string | End} effect
 * @property {Partial<ImplData>} [changes]
 */

/** @type {EdgeCase[]} */
// The shared start's edges are the start sync's (#419), in
// implementor-sync-edge-fixtures.mjs.
const EDGES = [
  {
    at: "implement-work?",
    result: "work",
    next: "setup",
    effect: "check:setup",
  },
  {
    at: "implement-work?",
    result: "built",
    next: "flows",
    effect: "check:flows",
  },
  {
    at: "implement-work?",
    result: "none",
    next: "wiki-only",
    effect: { kind: "saved", stage: "review" },
  },
  {
    at: "setup",
    result: "ok",
    next: "implementer",
    effect: "session:implement",
  },
  {
    at: "implementer",
    result: "replied",
    reply: DONE,
    next: "implementer-reply",
    effect: "check:implementer-reply",
    changes: { reply: DONE },
  },
  {
    at: "implementer-reply",
    result: "done",
    data: { reply: DONE },
    next: "flows",
    effect: "check:flows",
  },
  {
    at: "implementer-reply",
    result: "handoff",
    data: { reply: HANDOFF, continuations: 0 },
    next: "implementer",
    effect: "session:implement",
    changes: { continuations: 1 },
  },
  {
    at: "implementer-reply",
    result: "handoff",
    data: { reply: HANDOFF, continuations: 1 },
    next: "out-of-room",
    effect: outOfRoom(1, HANDOFF.summary),
    changes: { continuations: 1 },
  },
  {
    at: "implementer-reply",
    result: "blocked",
    data: { reply: BLOCKED },
    next: "blocked",
    effect: stoppedWith("not-doable", BLOCKED_REASON, BLOCKED.summary),
  },
  {
    at: "implementer-reply",
    result: "bad",
    data: { reply: null },
    next: "bad-reply",
    effect: stoppedWith("error", BAD_REPLY, ""),
  },
  {
    at: "flows",
    result: "code",
    reply: PUSHED_CODE,
    data: { pr: 42 },
    next: "implemented",
    effect: { kind: "saved", stage: "review" },
    changes: {
      headSha: PUSHED_CODE.headSha,
      flows: PUSHED_CODE.flows,
      implemented: true,
    },
  },
  {
    at: "flows",
    result: "code",
    reply: PUSHED_CODE,
    data: { pr: null },
    next: "implemented",
    effect: { kind: "saved", stage: "open-pr" },
    changes: { headSha: PUSHED_CODE.headSha, implemented: true },
  },
  {
    at: "flows",
    result: "none",
    reply: PUSHED_NONE,
    next: "changed-nothing",
    effect: stoppedWith("not-doable", CHANGED_NOTHING, ""),
    changes: { headSha: PUSHED_NONE.headSha, flows: PUSHED_NONE.flows },
  },
];

export { EDGES };
