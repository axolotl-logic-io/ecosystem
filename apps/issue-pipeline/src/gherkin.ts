// Installed compatibility bootstrap. Task code receives no buddy configuration.
import { gherkin } from "@ecosystem/gherkin";
import { executeTask } from "@ecosystem/task-framework";
import { loadConfig } from "./config.ts";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { issueContext } from "./task-app/issue-file.ts";
import { gherkinSessionHost } from "./task-app/session.ts";
import { main, type TaskRun } from "./task-app/task-app.ts";

// Marker format and comment recovery are private to this issue adapter.
function publish(run: TaskRun, name: string, body: string): void {
  run.checkStop();
  const payload = { run: run.run };
  if (name === "questions") {
    run.comment(body, "questions", payload);
    return;
  }
  if (name !== "gherkin") {
    throw new OpsError(`unknown Gherkin artifact: ${name}`);
  }
  const earlier = run.recovery.earlierComments("gherkin").at(-1);
  if (earlier === undefined) {
    run.comment(body, "gherkin", payload);
  } else {
    run.edit(earlier.comment.id, body, "gherkin", payload);
  }
}

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
      artifacts: {
        publish: (name: string, body: string): Promise<void> =>
          Promise.resolve(publish(run, name, body)),
      },
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
