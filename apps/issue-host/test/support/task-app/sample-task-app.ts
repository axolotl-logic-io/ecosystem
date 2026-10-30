// A sample task app on the task app framework, for the framework's tests.
// Its work counts the notes earlier runs of it left on the issue and posts
// the next one. The test seams are its environment:
//
// - SAMPLE_TASK_GATE: a FIFO path. The work writes `ready` to the FIFO
//   GATE.ready, then waits until something is written to GATE, so a test
//   can hold a run live and act while it is.
// - SAMPLE_TASK_FAIL: an error message the work throws after the gate.
// - SAMPLE_TASK_ID: the task it runs as, `gherkin` when unset, so a test can
//   install it as another task's app.
import fs from "node:fs";
import process from "node:process";
import { main, type TaskRun } from "../../../src/task-app/task-app.ts";

const {
  SAMPLE_TASK_GATE: gate,
  SAMPLE_TASK_FAIL: failure,
  SAMPLE_TASK_ID: task,
}: NodeJS.ProcessEnv = process.env;

await main({
  id: task || "gherkin",
  work: (run: TaskRun): void => {
    const earlier = run.recovery.earlierComments("note").length;
    if (gate !== undefined && gate !== "") {
      fs.writeFileSync(`${gate}.ready`, "ready\n");
      fs.readFileSync(gate);
    }
    if (failure !== undefined && failure !== "") {
      throw new Error(failure);
    }
    run.comment(`Sample note ${earlier + 1}.`, "note", { run: run.run });
  },
});
