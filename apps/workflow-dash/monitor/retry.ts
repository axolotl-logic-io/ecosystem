// Explicit user actions, separate from monitoring reads. A retry requests
// work only by applying start:<task> with the user's gh credentials. It
// never launches a task or writes a monitoring or coordination record.

import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import { z } from "zod";
import { errorMessage } from "../errors.ts";
import type { ReadCommand } from "../github.ts";
import { exec } from "../process-observations.ts";
import { parse } from "../source-records.ts";
import { safeBody } from "./records.ts";

const taskSchema = z.enum(["author", "implement", "verify", "fix", "land"]);
const repoPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u;
const targetSchema = z.object({
  action: z.string().min(1),
  repo: z.string().regex(repoPattern),
  issue: z.number().int().positive(),
  task: taskSchema,
});
const issueSchema = z.object({
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({ name: z.string() })),
});
const retryStates = new Set([
  "failed",
  "blocked",
  "interrupted",
  "stopped",
  "unknown",
]);
const commandOptions = { timeout: 30_000, maxBuffer: 65_536 };
type RetryTarget = z.infer<typeof targetSchema>;

/** The failed task selected in monitoring, not a generic subagent or finished work. */
function retryTarget(
  action: MonitorEntity | null | undefined,
): RetryTarget | null {
  if (action?.kind !== "action" || !retryStates.has(action.state)) {
    return null;
  }
  const parsed = targetSchema.safeParse({
    action: action.id,
    repo: action.repo,
    issue: action.issue,
    task: action.task,
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
   * Apply a new start, once per selected attempt. A present start is left alone:
   * removing it could consume a newer request. Ambiguous writes are not retried.
   */
  async request(input: RetryTarget): Promise<string> {
    const target = targetSchema.parse(input);
    const { action, repo, issue, task } = target;
    if (!this.repositories.includes(repo)) {
      throw new Error("This repository is not configured in the dashboard.");
    }
    if (this.busy.has(action) || this.requested.has(action)) {
      return "Retry was already requested for this attempt.";
    }
    this.busy.add(action);
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
        return `${label} is already present. I left it unchanged; the buddy may be waiting or reconciling the previous run. No new start was created.`;
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
        this.requested.add(action);
        return `The retry request could not be confirmed. Check ${label} on GitHub before trying again. ${safeBody(errorMessage(error))}`;
      }
      this.requested.add(action);
      return `Requested ${task} for ${repo} #${issue} with ${label}. The buddy will continue the existing work after its normal checks.`;
    } finally {
      this.busy.delete(action);
    }
  }
}

export type { RetryTarget };
export { RetryRequests, retryTarget };
