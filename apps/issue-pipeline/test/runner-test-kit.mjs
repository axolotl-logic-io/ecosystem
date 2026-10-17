// @ts-check
// The role runner's fake effects, over a durable store and the fake gh. Toy
// ops post signed comments through gh, each with its hidden marker, and check
// the store's markers before acting, so a rerun posts nothing twice; saves
// write the store's state. Every effect call is recorded. killAt makes the
// k-th effect call (saves included) never settle, before or after its durable
// write; a restart then runs again from the store alone, as a job started
// afresh would. uninterrupted gives the reference run. Usage entries go to
// the world's `usages`, outside `calls` and the kill count. A test may run
// its own role over its own start state, context, sessions and op fakes; the
// toys' are the defaults.
import { spawnSync } from "node:child_process";
import { runLinear, runMachine } from "../src/job/runner.ts";
import { installFakeGh } from "./fake-gh.mjs";
import { roleContext } from "./role-context-fixtures.mjs";
import { ISSUE, startState, TOY_SCRIPT, toyMachine } from "./runner-toys.mjs";

/** @import { CheckEffect, Effects, OpEffect, Outcome } from "../src/job/run-step.ts" */
/** @import { Entry, RunEnd } from "../src/job/runner.ts" */
/** @import { UsageEntry } from "../src/job/run-usage.ts" */
/** @import { LaunchUsage } from "../src/job/usage-tally.ts" */
/** @import { SessionEffect } from "../src/roles/machine.ts" */
/** @import { Machine, RoleContext } from "../src/roles/walk.ts" */
/** @import { State } from "../src/state.ts" */
/** @import { ToyData } from "./runner-toys.mjs" */

const CLOCK = new Date("2026-10-16T12:00:00Z");
const gh = installFakeGh();

/**
 * @typedef {object} WorldOptions
 * @property {Readonly<Record<string, string>>} [failOp] an error for each post marker that fails
 * @property {(tries: number) => string} [verify] the verify check's result for a count
 * @property {boolean} [verifyFails] whether the verify check fails outright
 * @property {string} [failSave] the error every save fails with
 * @property {number} [signalAt] the call during which SIGTERM arrives
 * @property {Outcome | ((effect: SessionEffect) => Outcome)} [session] what every session, or each, comes to
 * @property {boolean} [contextStop] whether the context watch stopped every session
 * @property {() => State} [start] the store's state before the first run
 * @property {RoleContext} [context] what the role's locate reads besides the state
 * @property {Readonly<Record<string, OpFake>>} [ops] fakes for the ops they name; any other op is a toy post
 * @property {(saved: State) => boolean} [restarts] whether a killed run starts again, as the claim would decide
 */

/** @typedef {{ kind: string, name: string, state?: State }} Call */
/** @typedef {{ reply: Outcome, write?: () => void }} Act */
/** @typedef {{ k: number, when: "before" | "after" }} Kill */
/** @typedef {{ saved: State, markers: Set<string>, labels: Set<string> }} Store */
/** @typedef {(store: Store, payload: Readonly<Record<string, unknown>>) => Act} OpFake */
/** @typedef {"machine" | "linear"} ToyRole */
/** @typedef {(entry: Entry, effects: Effects) => Promise<RunEnd>} RoleRun */

/** @type {Outcome} */
const OK = { ok: true, name: "ok", reply: null };
/** @type {Outcome} */
const REPLIED = { ok: true, name: "replied", reply: { plan: "toy plan" } };

/** @type {LaunchUsage} what every toy session's launch spent */
const LAUNCH = {
  turns: 3,
  tokens: { input: 900, output: 120, cacheRead: 4000, cacheWrite: 300 },
  first: 1200,
  peak: 5300,
  atFinish: 5000,
  steered: false,
  stopped: false,
  tools: { read: { calls: 2, outputChars: 800 } },
  largest: { tool: "read", chars: 500 },
  seconds: 7,
};

/** @param {unknown} value @returns {string} */
function textOf(value) {
  return String(value);
}

/** @param {string} marker @param {string} body */
function postComment(marker, body) {
  const text = `${body}\n<!-- issue-pipeline:${ISSUE}:${marker} -->`;
  spawnSync("gh", ["issue", "comment", String(ISSUE), "--body", text]);
}

/** @param {Store} store @param {WorldOptions} options @param {OpEffect} effect @returns {Act} */
function opAct(store, options, effect) {
  const { marker, body } = effect.payload;
  const name = textOf(marker);
  const { [name]: error } = options.failOp ?? {};
  if (error !== undefined) {
    return { reply: { ok: false, error } };
  }
  return {
    write: () => {
      if (!store.markers.has(name)) {
        postComment(name, textOf(body));
        store.markers.add(name);
      }
    },
    reply: { ok: true, name: "ok", reply: { ok: true } },
  };
}

/**
 * An op's call: through the test's fake for it, or as a toy post.
 * @param {Store} store @param {WorldOptions} options @param {OpEffect} effect
 * @returns {{ entry: Call, act: Act }}
 */
function opCall(store, options, effect) {
  const { [effect.op]: fake } = options.ops ?? {};
  if (fake !== undefined) {
    return {
      entry: { kind: "op", name: effect.op },
      act: fake(store, effect.payload),
    };
  }
  const { marker } = effect.payload;
  return {
    entry: { kind: "op", name: textOf(marker) },
    act: opAct(store, options, effect),
  };
}

/**
 * What session `effect` comes to: the test's outcome for it, or the toy plan.
 * @param {WorldOptions} options @param {SessionEffect} effect
 * @returns {Outcome}
 */
function sessionReply(options, effect) {
  const { session } = options;
  if (typeof session === "function") {
    return session(effect);
  }
  return session ?? REPLIED;
}

/** @param {WorldOptions} options @param {CheckEffect} effect @returns {Act} */
function checkAct(options, effect) {
  if (options.verifyFails === true) {
    return { reply: { ok: false, error: "verify broke" } };
  }
  const { tries } = effect.payload;
  const verify = options.verify ?? (() => "pass");
  return { reply: { ok: true, name: verify(Number(tries)), reply: null } };
}

/** @param {Store} store @param {WorldOptions} options @param {State} state @returns {Act} */
function saveAct(store, options, state) {
  if (options.failSave !== undefined) {
    return { reply: { ok: false, error: options.failSave } };
  }
  return {
    write: () => {
      store.saved = structuredClone(state);
    },
    reply: OK,
  };
}

/** @param {UsageEntry[]} list @returns {Effects["usage"]} an effect that appends to `list` */
function appendTo(list) {
  return (entry) => {
    list.push(entry);
    return Promise.resolve();
  };
}

/** @param {WorldOptions} options @returns {Store} the store before any run */
function storeOf(options) {
  const saved = (options.start ?? startState)();
  return { saved, markers: new Set(), labels: new Set() };
}

/**
 * A world: the durable store, every call made, and fresh effects over it.
 * @param {WorldOptions} [options]
 */
function world(options = {}) {
  const store = storeOf(options);
  /** @type {Call[]} */
  const calls = [];
  /** @type {UsageEntry[]} */
  const usages = [];
  /** @type {"SIGTERM" | null} */
  let signal = null;
  /**
   * Effects whose k-th call never settles, after its write when `when` is
   * "after"; `killed` resolves then. `made` lists their own calls.
   * @param {Kill} [kill]
   * @returns {{ effects: Effects, killed: Promise<"killed">, made: Call[] }}
   */
  function effects(kill) {
    /** @type {Call[]} */
    const made = [];
    /** @type {PromiseWithResolvers<"killed">} */
    const { promise: killed, resolve } = Promise.withResolvers();
    /** @param {Call} entry @param {Act} act @returns {Promise<Outcome>} */
    function run(entry, act) {
      made.push(entry);
      calls.push(entry);
      if (kill?.k === made.length) {
        if (kill.when === "after") {
          act.write?.();
        }
        resolve("killed");
        return new Promise(() => undefined);
      }
      act.write?.();
      if (options.signalAt === made.length) {
        signal = "SIGTERM";
      }
      return Promise.resolve(act.reply);
    }
    /** @type {Effects} */
    const all = {
      op: (effect) => {
        const { entry, act } = opCall(store, options, effect);
        return run(entry, act);
      },
      check: (effect) =>
        run({ kind: "check", name: effect.check }, checkAct(options, effect)),
      session: async (effect) => ({
        outcome: await run(
          { kind: "session", name: effect.name },
          { reply: sessionReply(options, effect) },
        ),
        launch: { ...LAUNCH, stopped: options.contextStop === true },
      }),
      usage: appendTo(usages),
      save: (state) =>
        run(
          { kind: "save", name: "save", state },
          saveAct(store, options, state),
        ),
      clock: () => CLOCK,
      stopping: () => signal,
      step: () => undefined,
    };
    return { effects: all, killed, made };
  }
  return { store, calls, usages, effects, options };
}

/** @typedef {ReturnType<typeof world>} World */

/**
 * Runs `role`, a toy or the test's own, from the store's state.
 * @param {ToyRole | RoleRun} role
 * @param {World} place
 * @param {Effects} effects
 * @param {Machine<string, string, ToyData>} [machine]
 * @returns {Promise<RunEnd>}
 */
function runToy(role, place, effects, machine = toyMachine()) {
  const { saved } = place.store;
  const context = place.options.context ?? roleContext();
  const entry = { stage: String(saved.stage), saved, context };
  if (typeof role === "function") {
    return role(entry, effects);
  }
  if (role === "machine") {
    return runMachine(machine, entry, effects);
  }
  return runLinear(TOY_SCRIPT, entry, effects);
}

/** @returns {string[][]} the gh calls that changed GitHub */
function writes() {
  return gh.writes(() => false);
}

/**
 * The end, saved state and gh writes of a run of the toy `role` killed at
 * its k-th effect call and started again from the store, or never killed;
 * `calls` holds both runs' calls and `restart` the second run's. A killed
 * run the claim wouldn't start again ends "killed".
 * @param {ToyRole | RoleRun} role
 * @param {Kill} [kill]
 * @param {WorldOptions} [options]
 */
async function killAt(role, kill, options = {}) {
  gh.reply([]);
  const place = world(options);
  const first = place.effects(kill);
  /** @type {RunEnd | "killed"} */
  let end = await Promise.race([
    runToy(role, place, first.effects),
    first.killed,
  ]);
  /** @type {Call[]} */
  let restart = [];
  if (end === "killed" && (options.restarts?.(place.store.saved) ?? true)) {
    const second = place.effects();
    end = await runToy(role, place, second.effects);
    restart = second.made;
  }
  const { saved, labels } = place.store;
  return {
    end,
    saved,
    labels: [...labels].sort(),
    writes: writes(),
    calls: place.calls,
    restart,
  };
}

/** @param {ToyRole | RoleRun} role @param {WorldOptions} [options] */
function uninterrupted(role, options = {}) {
  return killAt(role, undefined, options);
}

export { gh, killAt, LAUNCH, runToy, uninterrupted, world, writes };
