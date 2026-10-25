// The durable hold a job started for an assignment records when it ends
// blocked (#174, src/assignment/hold.ts): a `wait` with no task request to
// relay, or a deferral. A pause records nothing, since a paused run writes
// nothing and its pause is already GitHub's own assignment record. Nor does
// any other end: a stop, a question and progress are already durable in
// the saved state. A failed record is reported on stderr and changes
// nothing else: without it the next sweep starts the work once more.

import process from "node:process";
import type { HoldRecord } from "../assignment/hold.ts";
import {
  conditionOf,
  HOLD_KEY,
  holdBody,
  holdOf,
  nextHold,
} from "../assignment/hold.ts";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import type { RunOp } from "./ops-request.ts";
import type { JobLine, RoleStageEnd } from "./role-end.ts";
import type { PauseCheck } from "./role-pause.ts";

const BY = { role: "coordinator", agent: null, model: null, run: null };

// A job that may record a hold: started for an assignment when `paused`
// isn't null.
interface HoldingJob {
  cfg: Config;
  issue: number;
  stage: string;
  task?: { name: string } | null;
  dirs: { branch: string };
  runOp: RunOp;
  paused?: PauseCheck;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// The blocked end `line` reports, or null for any other.
function blockedOf(line: JobLine): Pick<HoldRecord, "end" | "reason"> | null {
  const reason = line.reason ?? line.end;
  if (line.end === "deferred") {
    return { end: "deferred", reason };
  }
  if (
    line.end === "wait" &&
    line.request === undefined &&
    !reason.startsWith("paused:")
  ) {
    return { end: "wait", reason };
  }
  return null;
}

// Records the hold a blocked `end` makes, then gives `end` unchanged.
async function recordHold(
  job: HoldingJob,
  end: RoleStageEnd,
): Promise<RoleStageEnd> {
  if (
    job.paused === undefined ||
    job.paused === null ||
    end.kind !== "finished"
  ) {
    return end;
  }
  const blocked = blockedOf(end.summary);
  if (blocked === null) {
    return end;
  }
  try {
    const condition = conditionOf(job.cfg, job.issue, job.dirs.branch);
    if (condition === null) {
      throw new Error("what the hold waits on couldn't be read");
    }
    const previous = holdOf(job.cfg, listComments(job.cfg, job.issue));
    const work = job.task?.name ?? job.stage;
    const record = nextHold(
      previous,
      { work, ...blocked, condition },
      new Date(),
    );
    const body = holdBody(record);
    const comments = [{ number: job.issue, by: BY, body, key: HOLD_KEY }];
    const reply = await job.runOp("post", { comments });
    if (!reply.ok) {
      throw new Error(reply.error);
    }
  } catch (error: unknown) {
    process.stderr.write(`job: assignment hold: ${messageOf(error)}\n`);
  }
  return end;
}

export { recordHold };
