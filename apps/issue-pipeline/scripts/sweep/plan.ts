// One sweep of one repo (#120): the work its assignments grant, started
// through the caller's launcher (caller-jobs/start.ts), and why everything
// else holds. It reads GitHub fresh every time and keeps no queue: the run
// folder only names the jobs already started, so a sweep can relay a task
// request a job printed, as the caller does.
//
//   repo not opted in (no assignments.grantor)     → hold the repo
//   open-issue listing cut short                   → hold the repo
//   issue assigned to neither buddy's account      → not considered
//   saved state unreadable, stopped or done        → hold
//   an `after` prerequisite not closed             → hold
//   next work: a task request the issue's last job
//     printed, else the saved stage (implement for
//     new work)
//   that work's buddy not assigned, or paused      → hold
//   a durable hold its last blocked job recorded,
//     on an unchanged condition (assignment/hold.ts) → hold
//   the launcher refuses (caps, attempts, a live
//     job on the issue)                            → hold
//   otherwise                                      → start, with --assignment
//
// The sweep decides no readiness. The stage job routes through
// task-readiness and ends `wait` with the task and binding to run, which
// the next sweep relays unchanged; the job's claim is the fenced claim.

import { z } from "zod";
import { assignmentGrant, listing } from "../../src/assignment/grant.ts";
import {
  branchOf,
  conditionOf,
  holdOf,
  holdReason,
} from "../../src/assignment/hold.ts";
import { AFTER_MARK } from "../../src/comment-marks.ts";
import type { IssueComment } from "../../src/comments.ts";
import { listComments } from "../../src/comments.ts";
import type { Config } from "../../src/config.ts";
import { loadConfig } from "../../src/config.ts";
import { issueState } from "../../src/github.ts";
import { buddyAccountOf } from "../../src/job/assignment.ts";
import type { JobTask } from "../../src/job/task-request.ts";
import { JOB_TASKS, TASK_NAMES } from "../../src/job/task-request.ts";
import { readClaimState } from "../../src/saved-state.ts";
import type { Stage } from "../../src/stages.ts";
import type { IssueState } from "../../src/state.ts";
import { reports } from "../caller-jobs/run-folder.ts";
import { Refusal, startJob } from "../caller-jobs/start.ts";
import { OPEN_ISSUE } from "./open-issues.ts";

// What one sweep decided for a repo, or for one of its issues.
interface Decision {
  repo: string;
  issue: number | null;
  start?: {
    stage: Stage;
    task: JobTask | null;
    attempt: number;
    receipt: string;
  };
  hold?: string;
}

// The work to start: a stage, or a task at its stage with its binding.
interface Work {
  stage: Stage;
  task: JobTask | null;
  binding: unknown;
}

type OpenIssue = z.infer<typeof OPEN_ISSUE>;

// A task request a job printed (docs/reference/coordination.md).
const REQUEST = z.looseObject({
  task: z.enum(["Sync", "Integration"]),
  binding: z.unknown(),
});

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// The task request the issue's last job printed, unless a later job took
// it up: the caller's relay (docs/reference/caller.md), from the run folder.
function pendingRequest(run: string, cfg: Config, issue: number): Work | null {
  const last = reports(run)
    .filter((job) => job.repo === cfg.repo && job.issue === issue)
    .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const request = REQUEST.safeParse(last?.request);
  if (
    last === undefined ||
    last.running ||
    last.task !== undefined ||
    !request.success
  ) {
    return null;
  }
  const task = JOB_TASKS.find((name) => TASK_NAMES[name] === request.data.task);
  if (task === undefined) {
    return null;
  }
  return { stage: last.stage, task, binding: request.data.binding };
}

// The issue's next work, or why it holds.
function workOf(
  run: string,
  cfg: Config,
  issue: number,
  state: IssueState | null,
): Work | string {
  const stage = state?.stage ?? "implement";
  if (stage === "stopped" || (state?.stopCode ?? null) !== null) {
    return `#${issue} is stopped (${state?.stopCode ?? "stopped"}); a person resumes it`;
  }
  if (stage === "done") {
    return `#${issue} is done`;
  }
  return (
    pendingRequest(run, cfg, issue) ?? { stage, task: null, binding: null }
  );
}

// The issue's first `after` prerequisite that GitHub doesn't show closed,
// as a hold, or null. A malformed marker or an unreadable issue holds too.
function unmetPrerequisite(cfg: Config, issue: OpenIssue): string | null {
  const body = issue.body ?? "";
  const { after } = AFTER_MARK.exec(body)?.groups ?? {};
  if (after === undefined) {
    if (body.includes("<!-- agent-pipeline:after")) {
      return "its after marker doesn't parse";
    }
    return null;
  }
  for (const number of after.split(",").filter(Boolean).map(Number)) {
    const state = issueState(cfg, number);
    if (state !== "closed") {
      return `prerequisite #${number} is ${state ?? "unreadable"}, not closed`;
    }
  }
  return null;
}

// Why the issue's durable hold (#174) still holds `what`, or null.
function heldBy(
  cfg: Config,
  work: { issue: number; branch: string; what: string },
  comments: readonly IssueComment[],
): string | null {
  try {
    const record = holdOf(cfg, comments);
    if (record === null || record.work !== work.what) {
      return null;
    }
    const current = conditionOf(cfg, work.issue, work.branch);
    return holdReason(record, work.what, current, new Date());
  } catch (error: unknown) {
    return `hold record: ${messageOf(error)}`;
  }
}

// The launcher's task arguments for `work`: none for a stage job.
function taskArgs(work: Work): { task?: JobTask; binding?: string } {
  if (work.task === null) {
    return {};
  }
  return { task: work.task, binding: JSON.stringify(work.binding) };
}

// What the sweep does with one assigned issue.
function decide(
  sweep: { run: string; config: string; lane: string },
  cfg: Config,
  issue: OpenIssue,
): Decision {
  const decided: Decision = { repo: cfg.repo, issue: issue.number };
  let state: IssueState | null;
  let comments: IssueComment[];
  try {
    comments = listComments(cfg, issue.number);
    state = readClaimState(cfg, issue.number, comments);
  } catch (error: unknown) {
    return { ...decided, hold: `saved state: ${messageOf(error)}` };
  }
  const blocked = unmetPrerequisite(cfg, issue);
  if (blocked !== null) {
    return { ...decided, hold: blocked };
  }
  const work = workOf(sweep.run, cfg, issue.number, state);
  if (typeof work === "string") {
    return { ...decided, hold: work };
  }
  const login = buddyAccountOf(cfg, work.stage, work.task);
  const what = work.task ?? work.stage;
  if (!issue.assignees.some((user) => same(user.login, login))) {
    return {
      ...decided,
      hold: `${what} is ${login}'s work, and ${login} isn't assigned`,
    };
  }
  const grant = assignmentGrant(cfg, issue.number, login);
  if (!grant.granted) {
    return { ...decided, hold: `paused: ${grant.why}` };
  }
  const branch = branchOf(issue.number, state?.branch);
  const held = heldBy(cfg, { issue: issue.number, branch, what }, comments);
  if (held !== null) {
    return { ...decided, hold: held };
  }
  try {
    const started = startJob({
      run: sweep.run,
      config: sweep.config,
      issue: issue.number,
      branch,
      lane: sweep.lane,
      stage: work.stage,
      ...taskArgs(work),
      assignment: true,
    });
    const { attempt, receipt } = started;
    return {
      ...decided,
      start: { stage: work.stage, task: work.task, attempt, receipt },
    };
  } catch (error: unknown) {
    if (error instanceof Refusal) {
      return { ...decided, hold: `refused: ${error.message}` };
    }
    throw error;
  }
}

// One sweep of the repo `sweep.config` configures.
function sweepRepo(sweep: {
  run: string;
  config: string;
  lane: string;
}): Decision[] {
  const cfg = loadConfig(sweep.config);
  if (cfg.assignments === undefined) {
    const hold = `assignment mode isn't enabled for ${cfg.repo} (assignments.grantor)`;
    return [{ repo: cfg.repo, issue: null, hold }];
  }
  const open = listing(
    cfg,
    `repos/${cfg.repo}/issues?state=open&per_page=100`,
    OPEN_ISSUE,
  );
  if (open === null) {
    const hold = "the open-issue listing was cut short; nothing starts from it";
    return [{ repo: cfg.repo, issue: null, hold }];
  }
  const buddies = [cfg.devAccount, cfg.landingAccount];
  return open
    .filter(
      (issue) =>
        issue.pullRequest === undefined &&
        issue.assignees.some((user) =>
          buddies.some((login) => same(login, user.login)),
        ),
    )
    .toSorted((a, b) => a.number - b.number)
    .map((issue) => decide(sweep, cfg, issue));
}

export type { Decision };
export { sweepRepo };
