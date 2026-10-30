// Compatibility hosts retain CLI failure semantics for blocked prerequisites.
import type { TaskDefinition } from "@ecosystem/task-framework";
import { executeTask } from "@ecosystem/task-framework";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { TaskRun } from "../task-app/task-app.ts";

async function execute<Inputs, Capabilities>(
  task: TaskDefinition<Inputs, Capabilities, string>,
  inputs: Inputs,
  capabilities: Capabilities,
  run: TaskRun,
): Promise<void> {
  const result = await executeTask(
    task,
    { version: 1, task: task.id, execution: run.run, inputs },
    (): Promise<Capabilities> => Promise.resolve(capabilities),
    {
      signal: new AbortController().signal,
      artifacts: {
        publish: (name: string, content: string): Promise<void> => {
          run.comment(content, name, {});
          return Promise.resolve();
        },
      },
      cleanup: (): Promise<void> => Promise.resolve(),
      report: (): Promise<void> => Promise.resolve(),
    },
  );
  if (result.status === "failed") {
    throw result.error;
  }
  if (result.status === "cancelled") {
    throw result.reason;
  }
  if (result.outcome.status === "blocked") {
    throw new OpsError(result.outcome.result);
  }
  if (result.outcome.status === "needs-input") {
    run.comment(result.outcome.result, "needs-input", {});
  }
}

export { execute };
