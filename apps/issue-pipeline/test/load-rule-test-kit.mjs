// @ts-check
// The writer rule against artificial load (#409): how many times a task
// carries it.
import { NO_ARTIFICIAL_LOAD_RULE } from "../src/workflow/prompts.ts";

// How many times `task` holds the rule's text.
/** @param {string} task @returns {number} */
function ruleCount(task) {
  return task.split(NO_ARTIFICIAL_LOAD_RULE).length - 1;
}

export { ruleCount };
