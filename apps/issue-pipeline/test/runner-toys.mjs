// @ts-check
// Toy roles for the role runner's tests. The toy machine posts, asks a
// session for a plan and verifies it, retrying the session in a loop bounded
// by the `tries` count and `limits.maxTries`; once verified it goes on to its
// `checks` stage in the same job, posts again and ends saved at `merge`. The
// toy linear script posts, asks a session and posts again, then ends saved at
// `spec`. Both write `plan` as their hand-off; the machine's `tries` is its
// checkpoint, and `scratch` is data no save may carry.

/** @import { Effect, End, SessionEffect, StateSpec } from "../src/roles/machine.ts" */
/** @import { LinearScript, Machine } from "../src/roles/walk.ts" */
/** @import { State } from "../src/state.ts" */

const ISSUE = 7;

/** @typedef {{ tries: number, plan: string | null, scratch: string }} ToyData */
/** @typedef {StateSpec<string, string, ToyData>} ToyState */
/** @typedef {Record<string, ToyState>} ToyStates */
/** @typedef {"post" | "work" | "verify" | "done" | "checks" | "finished" | "gave-up" | "broken"} ToyAt */

/** @param {string} marker @returns {Effect} an op that posts a marked comment */
function post(marker) {
  return { kind: "op", op: "post", payload: { marker, body: `Toy ${marker}` } };
}

/** @type {SessionEffect} */
const WORK = {
  kind: "session",
  name: "work",
  agent: "toy-writer",
  model: "mock",
  schema: {
    type: "object",
    properties: { status: { type: "string", enum: ["done", "handoff"] } },
  },
  task: "Do the toy work.",
  tokenBudget: 1000,
  budgetRole: "implementer",
  attempt: 1,
};

/** @param {End} end @returns {Effect} */
function ending(end) {
  return { kind: "end", end };
}

/** @param {unknown} value @returns {string | null} the value's plan, if any */
function planOf(value) {
  if (typeof value !== "object" || value === null || !("plan" in value)) {
    return null;
  }
  const { plan } = value;
  if (typeof plan === "string") {
    return plan;
  }
  return null;
}

/** @param {ToyData} data @param {unknown} reply @returns {ToyData} */
function withPlan(data, reply) {
  return { ...data, plan: planOf(reply) };
}

/** @type {Record<ToyAt, ToyState>} */
const TOY_STATES = {
  post: {
    kind: "script",
    effect: () => post("toy-post"),
    on: { ok: { to: "work" } },
  },
  work: {
    kind: "session",
    effect: (data) => ({ ...WORK, attempt: data.tries + 1 }),
    on: { replied: { to: "verify", apply: withPlan } },
  },
  verify: {
    kind: "script",
    effect: (data) => ({
      kind: "check",
      check: "verify",
      payload: { tries: data.tries },
    }),
    on: {
      pass: { to: "done" },
      fail: {
        to: "work",
        count: { field: "tries", limit: "maxTries", over: "gave-up" },
      },
      failed: { to: "broken" },
    },
  },
  done: {
    kind: "end",
    effect: () => ending({ kind: "next", stage: "checks" }),
    on: {},
  },
  checks: {
    kind: "script",
    effect: () => post("toy-checks"),
    on: { ok: { to: "finished" } },
  },
  finished: {
    kind: "end",
    effect: () => ending({ kind: "saved", stage: "merge" }),
    on: {},
  },
  "gave-up": {
    kind: "end",
    effect: () => ending({ kind: "stopped", code: "limit" }),
    on: {},
  },
  broken: {
    kind: "end",
    effect: () => ending({ kind: "stopped", code: "broken" }),
    on: {},
  },
};

const TOY_ENTRIES = ["post", "checks"];
const TOY_LIMITS = { maxTries: 3 };

/** @param {State} saved @returns {ToyData} */
function toyData(saved) {
  const { tries } = saved.checkpoints ?? {};
  let count = 0;
  if (typeof tries === "number") {
    count = tries;
  }
  return { tries: count, plan: planOf(saved), scratch: "never saved" };
}

/**
 * The toy machine, with its retry loop bounded by `limits.maxTries`.
 * @param {{ limits?: Readonly<Record<string, number>>, states?: ToyStates }} [options]
 * @returns {Machine<string, string, ToyData>}
 */
function toyMachine(options = {}) {
  const { limits = TOY_LIMITS, states = TOY_STATES } = options;
  return {
    table: { entries: TOY_ENTRIES, states },
    limits,
    locate: (saved) => {
      let at = "post";
      if (saved.stage === "checks") {
        at = "checks";
      }
      return { at, data: toyData(saved) };
    },
    handoff: ["plan"],
    checkpoints: ["tries"],
  };
}

/** @type {LinearScript<ToyData>} */
const TOY_SCRIPT = {
  locate: (saved) => {
    const data = toyData(saved);
    let at = "announce";
    if (data.plan !== null) {
      at = "report";
    }
    return { at, data };
  },
  steps: [
    { name: "announce", kind: "script", effect: () => post("lin-announce") },
    { name: "think", kind: "session", effect: () => WORK, apply: withPlan },
    { name: "report", kind: "script", effect: () => post("lin-report") },
  ],
  end: () => ({ kind: "saved", stage: "spec" }),
  handoff: ["plan"],
  checkpoints: [],
};

/** @returns {State} issue #7 as a job claims it, with no plan yet */
function startState() {
  return {
    version: 1,
    number: ISSUE,
    stage: "implement",
    lease: { holder: "job" },
    plan: null,
  };
}

export {
  ISSUE,
  startState,
  TOY_ENTRIES,
  TOY_LIMITS,
  TOY_SCRIPT,
  TOY_STATES,
  toyMachine,
  WORK,
};
