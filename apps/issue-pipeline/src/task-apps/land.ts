// Installed compatibility bootstrap; Land owns domain reads and effects.
import { land } from "@ecosystem/land";
import { main, type TaskRun } from "../task-app/task-app.ts";
import { execute } from "./execute.ts";

async function work(run: TaskRun): Promise<void> {
  await execute(
    land,
    { issue: run.issue },
    { github: run.github, recovery: run.recovery, report: run.comment },
    run,
  );
}
await main({ id: land.id, work });
