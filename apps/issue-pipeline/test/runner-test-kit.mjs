// @ts-check
// The role runner's fake effects, over a durable store and the fake gh. Toy
// ops post signed comments through gh, each with its hidden marker, and check
// the store's markers before acting, so a rerun posts nothing twice; saves
// write the store's state. Every effect call is recorded. killAt makes the
// k-th effect call (saves included) never settle, before or after its durable
// write; a restart then runs again from the store alone, as a job started
// afresh would. uninterrupted gives the reference run.
import { spawnSync } from "node:child_process";
import { runLinear, runMachine } from "../src/job/runner.ts";
import { installFakeGh } from "./fake-gh.mjs";
import { ISSUE, startState, TOY_SCRIPT, toyMachine } from "./runner-toys.mjs";

/** @import { CheckEffect, Effects, OpEffect, Outcome, RunEnd } from "../src/job/runner.ts" */
/** @import { Machine } from "../src/roles/walk.ts" */
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
 */

/** @typedef {{ kind: string, name: string, state?: State }} Call */
/** @typedef {{ reply: Outcome, write?: () => void }} Act */
/** @typedef {{ k: number, when: "before" | "after" }} Kill */
/** @typedef {{ saved: State, markers: Set<string> }} Store */
/** @typedef {"machine" | "linear"} ToyRole */

/** @type {Outcome} */
const OK = { ok: true, name: "ok", reply: null };

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

/**
 * A world: the durable store, every call made, and fresh effects over it.
 * @param {WorldOptions} [options]
 */
function world(options = {}) {
  /** @type {Store} */
  const store = { saved: startState(), markers: new Set() };
  /** @type {Call[]} */
  const calls = [];
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
        const { marker } = effect.payload;
        const entry = { kind: "op", name: textOf(marker) };
        return run(entry, opAct(store, options, effect));
      },
      check: (effect) =>
        run({ kind: "check", name: effect.check }, checkAct(options, effect)),
      session: (effect) =>
        run(
          { kind: "session", name: effect.name },
          { reply: { ok: true, name: "replied", reply: { plan: "toy plan" } } },
        ),
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
  return { store, calls, effects };
}

/** @typedef {ReturnType<typeof world>} World */

/**
 * Runs the toy `role` from the store's state.
 * @param {ToyRole} role
 * @param {World} place
 * @param {Effects} effects
 * @param {Machine<string, string, ToyData>} [machine]
 * @returns {Promise<RunEnd>}
 */
function runToy(role, place, effects, machine = toyMachine()) {
  const { saved } = place.store;
  const entry = { stage: String(saved.stage), saved };
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
 * `calls` holds both runs' calls and `restart` the second run's.
 * @param {ToyRole} role
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
  if (end === "killed") {
    const second = place.effects();
    end = await runToy(role, place, second.effects);
    restart = second.made;
  }
  const { saved } = place.store;
  return { end, saved, writes: writes(), calls: place.calls, restart };
}

/** @param {ToyRole} role @param {WorldOptions} [options] */
function uninterrupted(role, options = {}) {
  return killAt(role, undefined, options);
}

export { gh, killAt, runToy, uninterrupted, world, writes };
