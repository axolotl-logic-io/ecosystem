// Installed compatibility bootstrap. Task code receives no buddy configuration.
import { gherkin } from "@ecosystem/gherkin";
import { executeTask } from "@ecosystem/task-framework";
import { issueArtifacts } from "@ecosystem/task-runtime/issue/artifacts";
import { issueContext } from "@ecosystem/task-runtime/issue/issue-file";
import { loadConfig } from "./config.ts";
import { gherkinSessionHost } from "./task-app/session.ts";
import { main, type TaskRun } from "./task-app/task-app.ts";

async function work(run: TaskRun): Promise<void> {
  const cfg = loadConfig(run.config);
  const inputs = {
    issue: {
      repository: run.issue.repo,
      number: run.issue.number,
      context: issueContext(run.github, {
        allowedUsers: cfg.allowedUsers,
        pipeline: [cfg.devAccount, cfg.landingAccount, run.account],
      }),
    },
    baseBranch: cfg.baseBranch,
    model: cfg.models.gherkin,
  };
  const session = gherkinSessionHost(run, cfg);
  const result = await executeTask(
    gherkin,
    { version: 1, task: gherkin.id, execution: run.run, inputs },
    (): Promise<typeof session.capabilities> =>
      Promise.resolve(session.capabilities),
    {
      signal: new AbortController().signal,
      artifacts: issueArtifacts(run.github, {
        task: gherkin.id,
        execution: run.run,
        baseBranch: cfg.baseBranch,
        update: ["gherkin"],
        append: ["questions"],
      }),
      cleanup: session.cleanup,
      // The claimed issue adapter owns final lifecycle reporting, including stop.
      report: (): Promise<void> => Promise.resolve(),
    },
  );
  if (result.status === "failed") {
    throw result.error;
  }
  if (result.status === "cancelled") {
    throw result.reason;
  }
}

await main({ id: gherkin.id, work });
