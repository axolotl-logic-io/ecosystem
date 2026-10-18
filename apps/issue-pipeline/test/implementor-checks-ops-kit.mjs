// @ts-check
// The implementor's checks for issue #7 at `checks` (#420), run with fake
// job effects: each op answers from a table of replies by op name and is
// recorded, and the comments the ops carry can be read back.
import { implementorChecks } from "../src/roles/implementor/checks.ts";
import { ISSUE, implContext } from "./implementor-role-test-kit.mjs";
import { JOB_CONFIG, JOB_ID, ROLE_CLOCK } from "./role-context-fixtures.mjs";

/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { OpEffect } from "../src/job/run-step.ts" */
/** @import { JobEffects } from "../src/roles/registry.ts" */

// What an op with no reply set answers.
const OK = { ok: true };
// Who signs the role's comments, as the machine passes it to a check.
const BY = {
  role: "implementer",
  agent: "issue-pipeline-writer",
  model: "fixer-model",
  run: JOB_ID,
};

/**
 * @typedef {object} Comment
 * @property {unknown} number
 * @property {unknown} body
 */

/**
 * The implementor's checks with fake effects whose ops answer from
 * `replies` (an op with none answers `{ ok: true }`), and the ops they ran.
 * @param {Record<string, Record<string, unknown>>} [replies]
 * @returns {{ run: (name: string, payload: Record<string, unknown>) => Promise<Outcome>, ops: OpEffect[] }}
 */
function checksWith(replies = {}) {
  /** @type {OpEffect[]} */
  const ops = [];
  const answers = new Map(Object.entries(replies));
  /** @type {JobEffects} */
  const effects = {
    op: (effect) => {
      ops.push(effect);
      const reply = new Map(Object.entries(answers.get(effect.op) ?? OK));
      if (reply.get("ok") !== true) {
        return Promise.resolve({
          ok: false,
          error: String(reply.get("error")),
        });
      }
      const answer = Object.fromEntries(reply);
      return Promise.resolve({ ok: true, name: "ok", reply: answer });
    },
    session: () => Promise.reject(new Error("a check ran a session")),
    sessions: () => Promise.reject(new Error("a check ran sessions")),
    usage: () => Promise.resolve(),
    save: () => Promise.resolve({ ok: true, name: "ok", reply: null }),
    clock: () => ROLE_CLOCK,
    stopping: () => null,
    step: () => undefined,
  };
  const entry = { stage: "checks", saved: {}, context: implContext() };
  const checks = new Map(
    Object.entries(implementorChecks(entry, effects, JOB_CONFIG)),
  );
  return {
    run: (name, payload) => {
      const check = checks.get(name);
      if (check === undefined) {
        return Promise.resolve({ ok: false, error: `no check named ${name}` });
      }
      return Promise.resolve(check({ number: ISSUE, by: BY, ...payload }));
    },
    ops,
  };
}

/** @param {readonly OpEffect[]} ops @returns {Comment[]} every comment the ops carried */
function commentsOf(ops) {
  return ops.flatMap((effect) => {
    const { comments } = effect.payload;
    if (!Array.isArray(comments)) {
      return [];
    }
    return comments;
  });
}

/** @param {readonly OpEffect[]} ops @param {string} op @returns {{ minutes: number | undefined, payload: Map<string, unknown> } | undefined} the first `op` the checks ran: its timeout and payload */
function opNamed(ops, op) {
  const effect = ops.find((ran) => ran.op === op);
  if (effect === undefined) {
    return;
  }
  return {
    minutes: numberOr(new Map(Object.entries(effect)).get("minutes")),
    payload: new Map(Object.entries(effect.payload)),
  };
}

/** @param {unknown} value @returns {number | undefined} the value when it is a number */
function numberOr(value) {
  if (typeof value !== "number") {
    return;
  }
  return value;
}

/** @param {Outcome} outcome @returns {{ name: string, reply: unknown }} the outcome's answer; a failed one throws */
function answerOf(outcome) {
  if (!outcome.ok) {
    throw new Error(`the check failed: ${outcome.error}`);
  }
  return { name: outcome.name, reply: outcome.reply };
}

export { answerOf, BY, checksWith, commentsOf, opNamed };
