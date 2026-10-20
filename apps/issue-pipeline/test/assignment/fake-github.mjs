// @ts-check
import { OpsError } from "../../src/ops-error.ts";
import { ISSUE_STATE } from "../../src/state.ts";
import { fakeHub } from "./fake-hub.mjs";
import { model } from "./fake-model.mjs";
import {
  clearRequest,
  event,
  issue,
  pull,
  request,
  review,
} from "./fake-wire.mjs";
import { assignmentConfig, fakeWorld } from "./world.mjs";

/** @import { WorkerDeps, JobResult } from '../../src/assignment/worker-state.ts' */
/** @import { World } from './world.mjs' */
/** @import { Hub } from '../../src/assignment/github.ts' */
/** @import { Execution } from '../../src/assignment/schema.ts' */
/** @param {World} f @param {Hub} hub @param {{model: (execution: Execution) => Promise<JobResult>}} callbacks @returns {WorkerDeps} */
function workerDeps(f, hub, callbacks) {
  return {
    hub,
    scope: () => {
      if (!f.world.scope) {
        throw new OpsError("scope withdrawn");
      }
    },
    now: () => new Date(f.world.now),
    comments: () => [],
    state: (number) => {
      const state = f.states.get(number);
      if (state === undefined) {
        return null;
      }
      return ISSUE_STATE.parse(structuredClone(state));
    },
    save: (number, state) => {
      f.states.set(number, ISSUE_STATE.parse(structuredClone(state)));
    },
    inputs: () => f.world.inputs,
    notice: (number, reason) => {
      f.notices.set(number, reason);
    },
    job: async (execution) => {
      f.launches.push(execution);
      return await callbacks.model(execution);
    },
  };
}
/** @param {ReturnType<typeof assignmentConfig>} [cfg] */
function fakeGithub(cfg = assignmentConfig()) {
  const f = fakeWorld(cfg);
  const hub = fakeHub(f);
  const callbacks = {
    model: (/** @type {Execution} */ execution) =>
      Promise.resolve(model(f, execution)),
  };
  return {
    ...f,
    hub,
    callbacks,
    deps: () => workerDeps(f, hub, callbacks),
    issue: (/** @type {number} */ number, author = "alice", actor = "alice") =>
      issue(f, number, author, actor),
    pull: (/** @type {number} */ number) => pull(f, number),
    event: (
      /** @type {number} */ number,
      /** @type {string} */ kind,
      /** @type {string} */ actor,
    ) => event(f, number, kind, { actor }),
    request: (
      /** @type {number} */ number,
      /** @type {string} */ actor,
      kind = "review_requested",
    ) => request(f, number, actor, kind),
    review: (
      /** @type {number} */ pr,
      /** @type {string} */ verdict,
      /** @type {{body?:string,author?:string,head?:string}} */ options = {},
    ) => review(f, pr, verdict, options),
    clearRequest: (/** @type {number} */ pr) => clearRequest(f, pr),
  };
}

export { fakeGithub };
