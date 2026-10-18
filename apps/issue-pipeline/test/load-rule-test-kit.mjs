// @ts-check
// The rule against artificial load (#409), which every role's task carries
// among its standing rules (src/roles/prompt-rules.ts, which keeps the text
// unexported): how many times a task carries it.

const NO_ARTIFICIAL_LOAD_RULE =
  "Make no artificial load: run only the commands your work needs, one at a time, and leave no process running when you finish.";

// How many times `task` holds the rule's text.
/** @param {string} task @returns {number} */
function ruleCount(task) {
  return task.split(NO_ARTIFICIAL_LOAD_RULE).length - 1;
}

export { ruleCount };
