// What a stage job does with its checkouts as it exits, on every exit: it
// closes them (checkout-close.ts), saving uncommitted patches and unpushed
// code recovery bundles before removal (or retaining the checkout if recovery
// fails); records the dropped paths and the patches in job.json;
// names the patches on stderr, which goes to job.log; and, when the run
// stopped, posts one keyed coordinator comment on the issue that says the
// patches were saved and where, naming only the job key, never a local path
// (dropped-changes-saved, #369). Nothing here applies a patch.

import path from "node:path";
import process from "node:process";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { Stage } from "../stages.ts";
import type { JobDirs } from "./checkout.ts";
import { closeJobCheckout } from "./checkout-close.ts";
import type { RunOp } from "./ops-request.ts";
import type { Access } from "./pipeline-commit.ts";
import type { JobLine } from "./role-end.ts";
import type { JobStatus, StopSignal } from "./status.ts";

// The separators an ISO time has that a job key leaves out.
const KEY_TIME_SEPARATORS = /[-:.]/gu;
// The checkout a dropped patch's file name ends with.
const PATCH_CHECKOUT = /-(?<checkout>repo|docs)\.patch$/u;
const NOTICE_BY = { role: "coordinator", agent: null, model: null, run: null };

// How a run ended: finished with the job's line, or stopped by a signal.
type RunEnd =
  | { kind: "finished"; summary: JobLine }
  | { kind: "stopped"; signal: StopSignal };

// An exiting job: its issue, key, folder and wiki access, its exit push
// (null for a role that never pushes), the runner its ops go through, and
// its status file.
interface ExitingJob {
  issue: number;
  stage: Stage;
  key: string;
  dirs: JobDirs;
  wiki: Access;
  push: (() => Promise<void>) | null;
  runOp: RunOp;
  status: JobStatus;
}

// The key of a job of `stage` that started at `at`: the stage and the UTC
// start, to the millisecond, as in `implement-20261017T074958123Z`.
function jobKeyOf(stage: string, at: Date): string {
  return `${stage}-${at.toISOString().replace(KEY_TIME_SEPARATORS, "")}`;
}

// True when the run that ended with `end` stopped: a signal ended it, or
// the role's stage ended with a stop. False for any other finish, and for a
// run that threw (null).
function stoppedRun(end: RunEnd | null): boolean {
  if (end === null) {
    return false;
  }
  if (end.kind === "stopped") {
    return true;
  }
  return end.summary.end === "stop";
}

// The comment that tells the issue job `key` saved its dropped changes as
// `patches`, paths relative to the issue's run directory.
function droppedNotice(key: string, patches: readonly string[]): string {
  const listed = patches.map((patch: string): string => {
    const { checkout } = PATCH_CHECKOUT.exec(patch)?.groups ?? {};
    if (checkout === undefined) {
      return `- \`${patch}\``;
    }
    return `- \`${checkout}/\`: \`${patch}\``;
  });
  return [
    `**Dropped changes saved** (job \`${key}\`)`,
    "",
    `Job \`${key}\` ended with uncommitted changes, which never reach the branch on their own. Before it dropped them, it saved them as patches in the \`dropped/\` folder of the issue's run directory:`,
    "",
    ...listed,
    "",
    "Nothing applies these patches on its own. To apply one, an operator checks out the commit on its `Base:` line and runs `git apply --index <patch>` there. They are removed only with the run directory.",
  ].join("\n");
}

// Posts `body` as the issue's comment keyed by the job's key; a failed post
// is reported on stderr.
async function postNotice(job: ExitingJob, body: string): Promise<void> {
  const { issue: number, key } = job;
  const comments = [{ number, by: NOTICE_BY, body, key: `dropped-${key}` }];
  const reply = await job.runOp("post", { comments });
  if (!reply.ok) {
    process.stderr.write(`job: dropped notice: ${reply.error}\n`);
  }
}

// Closes `job`'s checkouts and records what they dropped; when patches
// saved it, names them on stderr and, if the run that ended with `end`
// stopped, posts the dropped notice.
async function tearDown(
  cfg: Config,
  job: ExitingJob,
  end: RunEnd | null,
): Promise<void> {
  const { issue, key, dirs, wiki, push, status } = job;
  let outcome = "failed";
  let reason: string | null = null;
  if (end?.kind === "finished") {
    outcome = end.summary.end;
    reason = end.summary.reason ?? null;
  } else if (end?.kind === "stopped") {
    outcome = "stopped";
    reason = end.signal;
  }
  const recovery = { stage: job.stage, outcome, reason };
  const closing = { ...dirs, wiki, key, recovery };
  const { lost, patches } = await closeJobCheckout(cfg, issue, closing, push);
  status.lostChanges(lost, patches);
  if (patches.length === 0) {
    return;
  }
  const runDir = paths.runDir(cfg, issue);
  const saved = patches.map((patch: string): string =>
    path.join(runDir, patch),
  );
  process.stderr.write(`job: dropped changes saved: ${saved.join(" ")}\n`);
  if (stoppedRun(end)) {
    await postNotice(job, droppedNotice(key, patches));
  }
}

export type { ExitingJob, RunEnd };
export { droppedNotice, jobKeyOf, stoppedRun, tearDown };
