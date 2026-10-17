// @ts-check
// The triage role on the runner's fake effects (runner-test-kit.mjs): issue
// #7 as the job claims it at triage, the role as the registry gives it, the
// session's reply, and fakes of the ops it sends. `post` writes each keyed
// comment once through the fake gh and edits it after; `start-pr`, which
// triage no longer sends, is faked so a test sees one sent by name; `ask`
// and `stop` save their own state and set their labels as a set. A killed run starts again only while the claim would start it: at
// triage, neither stopped nor asked.
import { spawnSync } from "node:child_process";
import { roleOf } from "../src/roles/registry.ts";
import { JOB_CONFIG, roleContext } from "./role-context-fixtures.mjs";
import { killAt, uninterrupted } from "./runner-test-kit.mjs";

/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { State } from "../src/state.ts" */
/** @import { SweepConfig } from "../src/workflow/stages/types.ts" */
/** @import { Act, Kill, OpFake, RoleRun, WorldOptions } from "./runner-test-kit.mjs" */

const ISSUE = 7;
const PR = 42;
/** @type {Act["reply"]} */
const DONE = { ok: true, name: "ok", reply: { ok: true } };

/**
 * Runs triage as the registry gives it.
 * @param {Parameters<RoleRun>[0]} entry @param {Parameters<RoleRun>[1]} effects
 * @returns {ReturnType<RoleRun>}
 */
function runTriage(entry, effects) {
  const role = roleOf("triage");
  if (role === undefined) {
    throw new Error("triage isn't registered");
  }
  return role.run(entry, effects, JOB_CONFIG);
}

/** @param {Record<string, unknown>} [fields] @returns {State} */
function triageState(fields = {}) {
  return {
    version: 1,
    number: ISSUE,
    stage: "triage",
    depth: 0,
    lease: { holder: "job" },
    ...fields,
  };
}

/** @param {unknown} value @returns {readonly unknown[]} */
function listOf(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function recordOf(value) {
  if (typeof value === "object" && value !== null) {
    return { ...value };
  }
  return {};
}

/** @type {OpFake} */
function post(store, payload) {
  return {
    write: () => {
      const { comments } = payload;
      for (const item of listOf(comments)) {
        const { key, body } = recordOf(item);
        const marker = `<!-- issue-pipeline:${ISSUE}:${String(key)} -->`;
        const text = `${String(body)}\n${marker}`;
        if (store.markers.has(marker)) {
          const edit = `repos/o/r/issues/comments/${store.markers.size}`;
          spawnSync("gh", ["api", "-X", "PATCH", edit, "-f", `body=${text}`]);
        } else {
          spawnSync("gh", ["issue", "comment", String(ISSUE), "--body", text]);
          store.markers.add(marker);
        }
      }
    },
    reply: DONE,
  };
}

/** @type {OpFake} */
function startPr() {
  return {
    reply: { ok: true, name: "ok", reply: { ok: true, pr: PR, headSha: "h1" } },
  };
}

/** @type {OpFake} */
function ask(store, payload) {
  return {
    write: () => {
      const { state } = payload;
      store.saved = { ...recordOf(state), stage: "triage", questionsAt: "now" };
      store.labels.add("agent:needs-info");
    },
    reply: DONE,
  };
}

/** @type {OpFake} */
function stop(store, payload) {
  return {
    write: () => {
      const { state, reason, code } = payload;
      store.saved = {
        ...recordOf(state),
        stage: "stopped",
        stopReason: reason,
      };
      store.labels.add(`agent:stopped-${String(code)}`);
    },
    reply: DONE,
  };
}

const TRIAGE_OPS = { post, "start-pr": startPr, ask, stop };

/** @param {State} saved @returns {boolean} */
function restarts(saved) {
  const { stage, questionsAt } = saved;
  return stage === "triage" && questionsAt === undefined;
}

/**
 * The world for a triage run: `reply` is the session's structured output.
 * @param {{ reply?: unknown, start?: Record<string, unknown>, cfg?: Partial<SweepConfig>, ops?: Record<string, OpFake> }} [setup]
 * @returns {WorldOptions}
 */
function triageWorld(setup = {}) {
  /** @type {Outcome} */
  const replied = { ok: true, name: "replied", reply: setup.reply ?? null };
  return {
    start: () => triageState(setup.start),
    context: roleContext(setup.cfg),
    session: () => replied,
    ops: { ...TRIAGE_OPS, ...setup.ops },
    restarts,
  };
}

/** @param {Parameters<typeof triageWorld>[0]} [setup] */
function triage(setup) {
  return uninterrupted(runTriage, triageWorld(setup));
}

/** @param {Kill} kill @param {Parameters<typeof triageWorld>[0]} [setup] */
function killedTriage(kill, setup) {
  return killAt(runTriage, kill, triageWorld(setup));
}

/** @param {{ decision: string, reason?: string, questions?: string[], plan?: string }} fields */
function replyOf(fields) {
  return { reason: "", questions: [], plan: "", ...fields };
}

export { ISSUE, killedTriage, replyOf, TRIAGE_OPS, triage, triageState };
