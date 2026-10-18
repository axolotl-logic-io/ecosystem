// @ts-check
// The edges of the `fix` entry's re-review chain (#418): for each lens in
// ALL_LENSES order, a check that opens its re-reviewer when the lens has
// open findings and otherwise goes to the next lens, and the session whose
// reply is kept by lens; after the last lens, update-findings.
import { ALL_LENSES } from "../src/workflow/lenses.ts";
import { FIXED_HEAD, PATCH_ID, RESOLVED } from "./implementor-fix-test-kit.mjs";

/** @import { ImplState } from "../src/roles/implementor/locate.ts" */
/** @import { EdgeCase } from "./implementor-edge-fixtures.mjs" */

// After the fix round's push and prepare-review, in round 1.
const IN_ROUND = { fixRounds: 1, headSha: FIXED_HEAD, patchId: PATCH_ID };

/** @param {number} index @returns {ImplState} the state after lens `index`'s re-review: the next lens's check, or update-findings */
function afterLens(index) {
  const lens = ALL_LENSES[index + 1];
  if (lens === undefined) {
    return "update-findings";
  }
  return /** @type {ImplState} */ (`rereview-${lens}?`);
}

/** @param {number} index @returns {string} the next state's effect name */
function afterLensEffect(index) {
  if (ALL_LENSES[index + 1] === undefined) {
    return "check:update-findings";
  }
  return "check:rereview?";
}

/** @type {EdgeCase[]} */
const LENS_EDGES = ALL_LENSES.flatMap((lens, index) => {
  const check = /** @type {ImplState} */ (`rereview-${lens}?`);
  const session = /** @type {ImplState} */ (`rereview-${lens}`);
  /** @type {EdgeCase[]} */
  const edges = [
    {
      at: check,
      result: "open",
      data: IN_ROUND,
      next: session,
      effect: `session:rereview-${lens}-r1`,
    },
    {
      at: check,
      result: "none",
      data: IN_ROUND,
      next: afterLens(index),
      effect: afterLensEffect(index),
    },
    {
      at: session,
      result: "replied",
      reply: RESOLVED,
      data: IN_ROUND,
      next: afterLens(index),
      effect: afterLensEffect(index),
      changes: { rereviews: { [lens]: RESOLVED } },
    },
  ];
  return edges;
});

export { IN_ROUND, LENS_EDGES };
