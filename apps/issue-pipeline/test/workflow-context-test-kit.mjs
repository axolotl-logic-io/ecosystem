// @ts-check
// Shared pieces of the stage kits' contexts. A stage context names a model
// for every role, but each kit's stages launch only a few of them, so
// modelsWith() fills in the roles a kit doesn't launch. Ended is a session
// result as a test gives it.
/** @import { ChildResult, StageContext } from "../src/workflow/stages/types.ts" */

/** @typedef {StageContext["models"]} Models */
/**
 * A session's result as a test gives it, less the kind, the error and the
 * signature, which the kit fills in.
 * @typedef {Pick<ChildResult, "ok" | "structuredOutput"> & Partial<ChildResult>} Ended
 */

// The model a role gets when its kit never launches it.
const UNUSED = "unused/model";

/** @type {Models} */
const UNUSED_MODELS = {
  triage: UNUSED,
  spec: UNUSED,
  implementer: UNUSED,
  correctness: UNUSED,
  tests: UNUSED,
  scope: UNUSED,
  aggregator: UNUSED,
  fixer: UNUSED,
  verifier: UNUSED,
  security: UNUSED,
};

/**
 * Every role's model: `chosen`'s, and the unused one for the rest.
 * @param {Partial<Models>} chosen
 * @returns {Models}
 */
function modelsWith(chosen) {
  return { ...UNUSED_MODELS, ...chosen };
}

// Every kit's spawn cap leaves room unless a test says otherwise.
function hasRoom() {
  return true;
}

export { hasRoom, modelsWith };
