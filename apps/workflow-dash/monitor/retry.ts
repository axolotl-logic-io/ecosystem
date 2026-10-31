// Explicit user actions, separate from monitoring reads. A retry is a new
// task run, requested only by applying start:<task> with the user's gh
// credentials. It never launches a task or writes a monitoring record.

import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import { z } from "zod";
import { errorMessage } from "../errors.ts";
import { exec, type ReadCommand } from "../process-observations.ts";
import { parse } from "../source-records.ts";
import { isTaskRun } from "./model.ts";
import { safeBody } from "./records.ts";

const taskSchema = z.enum(["gherkin", "implement", "verify", "fix", "land"]);
const repoPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u;
const targetSchema = z.object({
  taskRun: z.string().min(1),
  repo: z.string().regex(repoPattern),
  issue: z.number().int().positive(),
  task: taskSchema,
});
const issueSchema = z.object({
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({ name: z.string() })),
});
const retryStates = new Set(["failed", "stopped"]);
const commandOptions = { timeout: 30_000, maxBuffer: 65_536 };
type RetryTarget = z.infer<typeof targetSchema>;

/** The failed or stopped task run selected in monitoring, if any. */
function retryTarget(
  taskRun: MonitorEntity | null | undefined,
): RetryTarget | null {
  if (
    taskRun === null ||
    taskRun === undefined ||
    !isTaskRun(taskRun) ||
    !retryStates.has(taskRun.state)
  ) {
    return null;
  }
  const parsed = targetSchema.safeParse({
    taskRun: taskRun.id,
    repo: taskRun.repo,
    issue: taskRun.issue,
    task: taskRun.task,
  });
  return parsed.data ?? null;
}

class RetryRequests {
  private readonly repositories: readonly string[];
  private readonly command: ReadCommand;
  private readonly busy = new Set<string>();
  private readonly requested = new Set<string>();
  constructor(repositories: readonly string[], command: ReadCommand = exec) {
    this.repositories = repositories;
    this.command = command;
  }
  /**
   * Apply a new start, once per selected task run. A present start is left alone:
   * removing it could consume a newer request. Ambiguous writes are not retried.
   */
  async request(input: RetryTarget): Promise<string> {
    const target = targetSchema.parse(input);
    const { taskRun, repo, issue, task } = target;
    if (!this.repositories.includes(repo)) {
      throw new Error("This repository is not configured in the dashboard.");
    }
    if (this.busy.has(taskRun) || this.requested.has(taskRun)) {
      return "Retry was already requested for this task run.";
    }
    this.busy.add(taskRun);
    try {
      const endpoint = `repos/${repo}/issues/${issue}`;
      const current = issueSchema.parse(
        parse(
          (await this.command("gh", ["api", endpoint], commandOptions)).stdout,
        ),
      );
      if (current.state !== "open") {
        return "The issue is closed; no retry was requested.";
      }
      const label = `start:${task}`;
      if (current.labels.some((item): boolean => item.name === label)) {
        return `${label} is already present, so no new start was created. A buddy claims it on its next poll unless agents:stop is on the issue.`;
      }
      try {
        await this.command(
          "gh",
          [
            "api",
            "--method",
            "POST",
            `${endpoint}/labels`,
            "-f",
            `labels[]=${label}`,
            "--silent",
          ],
          commandOptions,
        );
      } catch (error) {
        // Do not repeat a POST whose response was lost. The UI tells the user
        // to inspect GitHub rather than offering another automatic write.
        this.requested.add(taskRun);
        return `The retry request could not be confirmed. Check ${label} on GitHub before trying again. ${safeBody(errorMessage(error))}`;
      }
      this.requested.add(taskRun);
      return `Requested ${task} for ${repo} #${issue} with ${label}. The new task run continues from what earlier runs left on GitHub.`;
    } finally {
      this.busy.delete(taskRun);
    }
  }
}

export type { RetryTarget };
export { RetryRequests, retryTarget };
