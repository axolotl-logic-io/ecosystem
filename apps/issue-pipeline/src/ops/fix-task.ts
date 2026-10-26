// Fix's effects and its read-only reconciliation (tasks/fix.ts), on the v2
// records. Branch effects, thread replies and the PR's ready state use the
// development account, which opened the PR; the landing account reads it
// and records the run.
//
//   fix-merge      this action's own Fix attempt, its cause still standing
//                  on PR head R: merges exactly target T into R in the
//                  action's checkout with a merge commit, never a rebase,
//                  and reads the requests for changes standing on R and
//                  their blocking threads. A text conflict stays stopped in
//                  the checkout for the action's one Developer session.
//   fix-finish     after that session, or with none: concludes the merge the
//                  session resolved, checks the new head, pushes it, replies
//                  in every blocking thread and marks a draft PR ready. A
//                  conflict left unresolved keeps its stages as recovery
//                  evidence and pushes nothing.
//   fix-reconcile  settles an unsettled Fix as its original run from reads
//                  alone; never merges, pushes, replies or marks ready:
//       the branch at a new head from R containing T, pushed by fix-finish,
//       every blocking thread answered by the run and the PR ready → passed
//       the branch still at R → failed
//       anything else → held (unknown)

import { z } from "zod";
import { pushHead } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { isRevisionBinding } from "../domain.ts";
import { head, remoteHead, uncommitted } from "../git-state.ts";
import { gh, git } from "../github.ts";
import { saveSyncRecovery } from "../job/code-recovery.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, run } from "../process.ts";
import { conflictStages, rebaseInProgress, unmergedFiles } from "../rebase.ts";
import { pullRequest } from "../revision.ts";
import type { FixCause } from "../tasks/fix.ts";
import { standingCause } from "../tasks/fix.ts";
import { MODULES } from "../tasks/modules.ts";
import { isAncestor } from "../tasks/view.ts";
import type { BlockingThread, Requests } from "./fix-reviews.ts";
import { answeredBy, replyIn, requestsOn } from "./fix-reviews.ts";
import { openPrFor } from "./prs.ts";
import type { TaskOpSpec } from "./task-guard.ts";
import type { EffectOutcome, OpenRun } from "./task-run.ts";
import { openReconciliation, openRun, settled } from "./task-run.ts";

const FINISH = z.looseObject({
  // Why the session didn't finish, when it didn't.
  failed: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  replies: z
    .array(
      z.looseObject({
        comment: z.number().int().positive(),
        reply: z.string().min(1),
      }),
    )
    .optional(),
});
const FINISH_OP = "fix-finish";
// Git's commit environment for the ops' own merge commits: the checkout's
// pre-commit guard admits them, and no editor opens.
const MERGE_ENV: ReadonlyMap<string, string> = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["LC_ALL", "C"],
  ["GIT_EDITOR", "true"],
]);
const MARKER = /^\+(?:<{7}|>{7})(?: |$)|^\+={7}$/u;
const GITLINK = "160000";

// One Fix run's checkout: the original head R, the target T it merges, and
// the PR they belong to.
interface FixRun {
  open: OpenRun;
  wt: string;
  from: string;
  target: string;
}

interface Started {
  fix: {
    pr: number;
    base: string;
    conflicts: string[];
    requests: { id: number; author: string; body: string }[];
    threads: BlockingThread[];
    session: boolean;
  };
}

function fixOf(open: OpenRun): FixRun {
  const { binding, cfg, number } = open;
  if (!isRevisionBinding(binding)) {
    throw new OpsError("a Fix binding binds a revision");
  }
  return {
    open,
    wt: paths.worktree(cfg, number),
    from: binding.revision.code,
    target: binding.target.commit,
  };
}

function gitIn(wt: string, args: readonly string[]): string {
  return run("git", ["-C", wt, ...args]).stdout.trim();
}

function merging(wt: string): boolean {
  const args = ["-C", wt, "rev-parse", "-q", "--verify", "MERGE_HEAD"];
  return run("git", args, { allowFail: true }).code === 0;
}

function failed(fix: FixRun, reason: string): EffectOutcome {
  return settled(fix.open, { verdict: "failed", reason });
}

// Why the checkout can't take the merge, or null.
function checkoutProblem(fix: FixRun): string | null {
  const { wt, from } = fix;
  if (merging(wt) || rebaseInProgress(wt)) {
    return "a merge or rebase is already stopped in the checkout";
  }
  const dirty = uncommitted(wt, "the checkout");
  if (dirty !== null) {
    return dirty;
  }
  if (head(wt) !== from) {
    return `the checkout is not at the head ${from}`;
  }
  return null;
}

// Keeps a merge the session left unresolved as recovery evidence (its
// numbered stages and the checkout's commits, in the issue's recovery
// folder), then drops the stopped merge so nothing of it is pushed.
function keepConflict(fix: FixRun, reason: string): string {
  const { cfg, number } = fix.open;
  const files = unmergedFiles(fix.wt);
  try {
    saveSyncRecovery(cfg, number, fix.wt, reason);
  } catch (error) {
    if (!(error instanceof OpsError && error.message.startsWith(reason))) {
      throw error;
    }
  }
  run("git", ["-C", fix.wt, "merge", "--abort"]);
  return `${reason}: ${files.join(", ")}; its conflict stages and commits are saved in the issue's recovery folder, and nothing was pushed`;
}

// Merges target T into the checkout's head: no change when the head
// already contains T, a merge commit when it merges cleanly, and otherwise
// the files the stopped merge left unresolved. A conflict on a gitlink is
// no model's choice: it is kept, and the reason returned.
function mergeTarget(cfg: Config, fix: FixRun): string[] | { kept: string } {
  const { wt, from, target } = fix;
  const base = cfg.baseBranch;
  git(cfg, "dev", [
    "-C",
    wt,
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
  ]);
  if (isAncestor(wt, target, from)) {
    return [];
  }
  const branch = paths.branch(cfg, fix.open.number);
  const merged = run(
    "git",
    [
      "-C",
      wt,
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      `Merge ${base} into ${branch}`,
      target,
    ],
    { allowFail: true, env: MERGE_ENV },
  );
  if (!merging(wt)) {
    if (merged.code !== 0) {
      throw new OpsError(`the merge of ${target} failed: ${merged.stderr}`);
    }
    return [];
  }
  if (conflictStages(wt).some((entry) => entry.mode === GITLINK)) {
    return {
      kept: keepConflict(fix, `the merge of ${target} conflicts on a gitlink`),
    };
  }
  return unmergedFiles(wt);
}

// What this action's attempt takes effect on, or why it may not now: its
// prerequisites again, its cause still standing, and the PR at exactly R.
// A person's review must still stand on R as GitHub reports it.
function startable(
  fix: FixRun,
): { problem: string } | { pr: number; cause: FixCause; requests: Requests } {
  const { cfg, number, binding, evidence, attempt } = fix.open;
  const unmet = MODULES.fix.prerequisite(cfg, evidence, binding);
  if (unmet !== null) {
    return { problem: unmet };
  }
  const standing = standingCause(evidence.view, attempt.cause, fix.from);
  if ("reason" in standing) {
    return { problem: standing.reason };
  }
  const pr = openPrFor(cfg, number);
  if (pr === undefined) {
    return { problem: `#${number} has no open PR` };
  }
  if (pullRequest(cfg, number, pr).headSha !== fix.from) {
    return { problem: `PR #${pr}'s head is no longer ${fix.from}` };
  }
  const requests = requestsOn(cfg, pr, fix.from);
  const { cause } = standing;
  if (cause === "review" && !requests.requests.some((item) => !item.landing)) {
    return { problem: "no person's request for changes stands on the head" };
  }
  const dirty = checkoutProblem(fix);
  if (dirty !== null) {
    return { problem: dirty };
  }
  return { pr, cause, requests };
}

function fixMerge(cfg: Config, request: unknown): Started | EffectOutcome {
  const fix = fixOf(openRun(cfg, request, "fix", "fix-merge"));
  const start = startable(fix);
  if ("problem" in start) {
    return failed(fix, `nothing fixed: ${start.problem}`);
  }
  const conflicts = mergeTarget(cfg, fix);
  if (!Array.isArray(conflicts)) {
    return failed(fix, conflicts.kept);
  }
  const { pr, cause, requests } = start;
  return {
    fix: {
      pr,
      base: cfg.baseBranch,
      conflicts,
      requests: requests.requests.map(({ id, author, body }) => ({
        id,
        author,
        body,
      })),
      threads: requests.threads,
      session:
        conflicts.length > 0 ||
        requests.requests.length > 0 ||
        cause === "verify",
    },
  };
}

// Concludes a merge the session resolved and staged, or keeps one it left
// unresolved; the reason when the run can't go on.
function concluded(fix: FixRun): string | null {
  const { wt, target } = fix;
  if (!merging(wt)) {
    return null;
  }
  if (unmergedFiles(wt).length > 0) {
    return keepConflict(fix, `the merge of ${target} was left unresolved`);
  }
  const committed = run("git", ["-C", wt, "commit", "--no-edit"], {
    allowFail: true,
    env: MERGE_ENV,
  });
  if (committed.code !== 0) {
    return `the resolved merge could not be committed: ${committed.stderr}`;
  }
  return null;
}

// Why the checkout's new head can't be pushed as the Fix, or null: it is
// clean, has no conflict marker, and is a new head from R containing T.
function headProblem(fix: FixRun): string | null {
  const { wt, from, target } = fix;
  const dirty = uncommitted(wt, "the checkout");
  if (dirty !== null) {
    return dirty;
  }
  const diff = gitIn(wt, ["diff", "-U0", `${target}...HEAD`]);
  if (diff.split("\n").some((line) => MARKER.test(line))) {
    return "conflict markers remain in the change";
  }
  const local = head(wt);
  if (local === from) {
    return "Fix left the head unchanged";
  }
  if (!(isAncestor(wt, from, local) && isAncestor(wt, target, local))) {
    return `the new head ${local} does not contain both ${from} and ${target}`;
  }
  return null;
}

// The reply for each blocking thread, by the session's answer, or the
// threads it left unanswered.
function answersFor(
  threads: readonly BlockingThread[],
  replies: readonly { comment: number; reply: string }[],
): Map<number, string> | number[] {
  const answers = new Map(replies.map((item) => [item.comment, item.reply]));
  const missing = threads
    .map((thread) => thread.id)
    .filter((id) => !answers.has(id));
  if (missing.length > 0) {
    return missing;
  }
  return answers;
}

// Pushes the checked head, replies in each blocking thread and marks a
// draft PR ready; returns the head it pushed, or the uncertain outcome of a
// push that left the branch elsewhere.
function delivered(
  fix: FixRun,
  pr: number,
  answers: ReadonlyMap<number, string>,
): string | EffectOutcome {
  const { cfg, number, attempt } = fix.open;
  const local = head(fix.wt);
  pushHead(cfg, number, FINISH_OP);
  const remote = remoteHead(cfg, number);
  if (remote !== local) {
    return {
      verdict: "unknown",
      reason: `the Fix push left the branch at ${String(remote)}; reconcile by reading`,
    };
  }
  const requests = requestsOn(cfg, pr, fix.from);
  for (const thread of requests.threads) {
    const text = answers.get(thread.id);
    if (text !== undefined && !answeredBy(requests, thread, attempt.run.id)) {
      replyIn(cfg, pr, thread, { run: attempt.run.id, head: local, text });
    }
  }
  if (pullRequest(cfg, number, pr).draft) {
    gh(cfg, "dev", ["pr", "ready", String(pr), "-R", cfg.repo]);
  }
  return local;
}

function fixFinish(cfg: Config, request: unknown): EffectOutcome {
  const fix = fixOf(openRun(cfg, request, "fix", FINISH_OP));
  const req = parseRequest(FINISH, FINISH_OP, request);
  if (req.failed !== undefined) {
    let reason = req.failed;
    if (merging(fix.wt)) {
      reason = keepConflict(fix, req.failed);
    }
    return failed(fix, reason);
  }
  const problem = concluded(fix) ?? headProblem(fix);
  if (problem !== null) {
    return failed(fix, problem);
  }
  const pr = openPrFor(cfg, fix.open.number);
  if (pr === undefined) {
    return failed(fix, `#${fix.open.number} has no open PR`);
  }
  const answers = answersFor(
    requestsOn(cfg, pr, fix.from).threads,
    req.replies ?? [],
  );
  if (Array.isArray(answers)) {
    return failed(
      fix,
      `the Fix session answered no blocking comment ${answers.join(", ")}`,
    );
  }
  const pushed = delivered(fix, pr, answers);
  if (typeof pushed !== "string") {
    return pushed;
  }
  let reason = `merged ${fix.target} into ${fix.from} as ${pushed}`;
  if (req.summary !== undefined) {
    reason = req.summary;
  }
  return settled(
    fix.open,
    { verdict: "passed", reason, produced: pushed },
    { pr, base: fix.target, replies: [...answers.keys()] },
  );
}

function held(reason: string): EffectOutcome {
  return { verdict: "unknown", reason: `${reason}; a person reconciles it` };
}

// A run's replies are the read-only proof that fix-finish got past its
// push: without a blocking thread to show them, a moved branch holds.
function reconciled(fix: FixRun): EffectOutcome {
  const { cfg, number, evidence, attempt } = fix.open;
  const remote = evidence.view.revision?.code ?? null;
  if (remote === fix.from) {
    return { verdict: "failed", reason: "reconciled: Fix pushed no new head" };
  }
  if (
    remote === null ||
    !isAncestor(evidence.clone, fix.from, remote) ||
    !isAncestor(evidence.clone, fix.target, remote)
  ) {
    return held(
      `the branch is at ${String(remote)}, not a head from ${fix.from} containing ${fix.target}`,
    );
  }
  const pr = openPrFor(cfg, number);
  if (pr === undefined) {
    return held(`#${number} has no open PR`);
  }
  const requests = requestsOn(cfg, pr, fix.from);
  const answered = requests.threads.filter((thread) =>
    answeredBy(requests, thread, attempt.run.id),
  );
  if (
    answered.length === 0 ||
    answered.length !== requests.threads.length ||
    pullRequest(cfg, number, pr).draft
  ) {
    return held(
      `the branch moved to ${remote}, but this run's thread replies or the PR's ready state don't show fix-finish completed`,
    );
  }
  return {
    verdict: "passed",
    reason: `reconciled: Fix pushed ${remote} and answered every blocking thread`,
    produced: remote,
  };
}

function fixReconcile(cfg: Config, request: unknown): EffectOutcome {
  const open = openReconciliation(cfg, request, "fix", "fix-reconcile");
  return settled(open, reconciled(fixOf(open)), {
    reconciledBy: open.reconciler,
  });
}

// Fix's ops, which ops/writer-ops.ts lists.
const FIX_OPS: readonly TaskOpSpec[] = [
  { name: "fix-merge", kind: "substantive", op: fixMerge },
  { name: FINISH_OP, kind: "substantive", op: fixFinish },
  { name: "fix-reconcile", kind: "finalization", op: fixReconcile },
];

export { FIX_OPS };
