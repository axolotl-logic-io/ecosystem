// @ts-check
// The implementor role's machine for issue #7 (#414): its data as locate
// builds it from a saved state, the replies its implementer gives, a step
// through `transition`, and the ends it stops with.
import { locate } from "../src/roles/implementor/locate.ts";
import { transition } from "../src/roles/implementor/machine.ts";
import { outOfRoomReason } from "../src/workflow/stages/continuation.ts";
import { roleContext } from "./role-context-fixtures.mjs";

/** @import { State } from "../src/state.ts" */
/** @import { Effect, End, Step } from "../src/roles/machine.ts" */
/** @import { RoleContext } from "../src/roles/walk.ts" */
/** @import { ImplData, ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { ImplResult } from "../src/roles/implementor/machine.ts" */
/** @import { ImplReading } from "../src/roles/implementor/reply.ts" */

const ISSUE = 7;
const PRACTICES = ["AGENTS.md", "CONTRIBUTING.md"];
const SPEC = "## Behaviour\n\n1. src/a.ts does the thing.";
const HANDOFF_FILE = "/runs/issue-7/handoff.md";

// The implementer's replies, as the session gives them.
/** @type {ImplReading} */
const DONE = { status: "done", summary: "Built src/a.ts." };
/** @type {ImplReading} */
const HANDOFF = { status: "handoff", summary: "Half done." };
/** @type {ImplReading} */
const BLOCKED = { status: "blocked", summary: "The spec test can't pass." };
// Today's implement stage reply, with the fields the role's schema drops.
const OLD_DONE = {
  ...DONE,
  testsAdded: ["test/a.test.mjs"],
  prTitle: "Do the thing (#7)",
  prBody: "Closes #7",
};
// The reply the job gives a session it stopped at the hard context limit
// (src/job/context-watch.ts).
const HARD_LIMIT_HANDOFF = {
  status: "handoff",
  summary: "session hit the hard context limit (175000)",
  prTitle: "",
  prBody: "",
  testsAdded: [],
};

// What the `flows` check answers with after the push.
const PUSHED_CODE = { headSha: "bbbbbbb", flows: { code: true, wiki: false } };
const PUSHED_NONE = { headSha: "bbbbbbb", flows: { code: false, wiki: false } };

// The stop reasons.
const BLOCKED_REASON = "the implementer could not do the issue as written";
const CHANGED_NOTHING = "the implementer changed nothing";
const BAD_REPLY = "the implementer's reply could not be read";

/** @param {Partial<import("../src/workflow/stages/types.ts").SweepConfig>} [fields] @returns {RoleContext} issue #7's context, with its practices and a test command */
function implContext(fields = {}) {
  return roleContext({
    practices: PRACTICES,
    commands: { test: "npm test" },
    ...fields,
  });
}

/** @param {State} [saved] @param {RoleContext} [context] @returns {{ at: ImplState, data: ImplData }} where locate starts issue #7, saved at implement with a spec, a PR and `saved`'s fields */
function located(saved = {}, context = implContext()) {
  return locate(
    { stage: "implement", spec: SPEC, pr: 42, headSha: "aaaaaaa", ...saved },
    context,
  );
}

/** @param {Partial<ImplData>} [fields] @returns {ImplData} a fresh run's data, with `fields` replacing its own */
function dataWith(fields = {}) {
  return { ...located().data, ...fields };
}

/**
 * The step `result` (with `reply`) takes from `at`, with `fields` in data.
 * @param {ImplState} at
 * @param {ImplResult} result
 * @param {unknown} [reply]
 * @param {Partial<ImplData>} [fields]
 * @returns {Step<ImplState, ImplData>} the step
 */
function stepFrom(at, result, reply = null, fields = {}) {
  return transition({ at, data: dataWith(fields) }, { name: result, reply });
}

/** @param {Effect} effect @returns {string | End} an op's or check's name, a session's name, or an end */
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

/**
 * The end that stops #7 with `code`, posting `reason` through the stop op.
 * @param {string} code
 * @param {string} reason
 * @param {string} detail
 * @returns {End}
 */
function stoppedWith(code, reason, detail) {
  return {
    kind: "stopped",
    code,
    after: { op: "stop", payload: { number: ISSUE, code, reason, detail } },
  };
}

/** @param {number} max @param {string} summary @returns {End} the stop for a handoff with no continuation left */
function outOfRoom(max, summary) {
  return stoppedWith(
    "too-large",
    outOfRoomReason("implementer", max),
    `Latest handoff: ${HANDOFF_FILE}\n\n${summary}`,
  );
}

export {
  BAD_REPLY,
  BLOCKED,
  BLOCKED_REASON,
  CHANGED_NOTHING,
  DONE,
  dataWith,
  HANDOFF,
  HANDOFF_FILE,
  HARD_LIMIT_HANDOFF,
  ISSUE,
  implContext,
  located,
  nameOf,
  OLD_DONE,
  outOfRoom,
  PRACTICES,
  PUSHED_CODE,
  PUSHED_NONE,
  SPEC,
  stepFrom,
  stoppedWith,
};
