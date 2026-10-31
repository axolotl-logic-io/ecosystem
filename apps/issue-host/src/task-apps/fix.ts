// The installed `fix.mjs`: provisions Fix's inputs and capabilities from the
// repository config; configuration and credentials stay here.
import { type FixCapabilities, type FixWriter, fix } from "@ecosystem/fix";
import { FIX_REPLY } from "@ecosystem/fix/reply";
import { loadConfig } from "../config.ts";
import { main, type TaskRun } from "../task-app/task-app.ts";
import { execute } from "./execute.ts";
import { openWriter } from "./writer.ts";

async function work(run: TaskRun): Promise<void> {
  const cfg = loadConfig(run.config);
  const capabilities: FixCapabilities = {
    github: run.github,
    readPull: run.recovery.pullRequest,
    report: run.comment,
    checkStop: run.checkStop,
    openWriter: (head: string, base: string): FixWriter => {
      const writer = openWriter(run, head, base);
      return {
        directory: writer.dirs.repo,
        conflicts: writer.conflicts,
        push: writer.push,
        remove: writer.remove,
        session: (task: string): Promise<unknown> =>
          writer.session(task, FIX_REPLY),
      };
    },
  };
  await execute(
    fix,
    {
      issue: run.issue,
      account: run.account,
      verifyAccount: cfg.verifyAccount ?? cfg.landingAccount,
      testCommand: cfg.commands.test,
      model: cfg.models.developer,
    },
    capabilities,
    run,
  );
}
await main({ id: fix.id, work });
