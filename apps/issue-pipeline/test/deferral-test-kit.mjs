// What a stage does when an ops request fails on the network: it ends for
// this sweep at the same stage, with a log line, and stops nothing.

/** @import { StageState, Step } from "../src/workflow/stages/types.ts" */

// git's error when DNS for github.com fails, as an op's reply carries it.
const NETWORK_FAILURE =
  "git fetch exited 128: fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com";

// The parts of a step that show whether it deferred.
/** @param {Step} step @returns {object} */
function deferral(step) {
  const { st } = step.state;
  return {
    done: step.done,
    again: step.done && step.again,
    stop: step.stop,
    launches: Object.hasOwn(step, "launches"),
    held: step.state.held,
    stage: st.stage,
    log: st.log,
  };
}

// deferral() of a step that defers `given` after `op` failed on the network,
// its log line stamped `stamp`: done at the same stage, with no stop, no
// launches and no tokens charged.
/**
 * @param {StageState} given
 * @param {string} op
 * @param {string} stamp
 * @returns {object}
 */
function deferredFrom(given, op, stamp) {
  return {
    done: true,
    again: false,
    stop: null,
    launches: false,
    held: given.held,
    stage: given.st.stage,
    log: [
      ...(given.st.log ?? []),
      `${stamp} deferred: network error during ${op}; will retry next sweep`,
    ],
  };
}

export { deferral, deferredFrom, NETWORK_FAILURE };
