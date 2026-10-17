// @ts-check
// The writer rule against artificial load (#409): how many times a task
// carries it, and the session tasks a step launches.
import { NO_ARTIFICIAL_LOAD_RULE } from "../src/workflow/prompts.ts";
import { sessions } from "./stage-outcome-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

// How many times `task` holds the rule's text.
/** @param {string} task @returns {number} */
function ruleCount(task) {
  return task.split(NO_ARTIFICIAL_LOAD_RULE).length - 1;
}

// The task of every session `step` launches; throws when it launches none.
/** @param {Step} step @returns {string[]} */
function tasksOf(step) {
  const tasks = sessions(step).map((session) => session.task);
  if (tasks.length === 0) {
    throw new Error("the step launched no session");
  }
  return tasks;
}

// The task of the first session `step` launches.
/** @param {Step} step @returns {string} */
function taskOf(step) {
  const [task] = tasksOf(step);
  if (task === undefined) {
    throw new Error("the step launched no session");
  }
  return task;
}

export { ruleCount, taskOf, tasksOf };
