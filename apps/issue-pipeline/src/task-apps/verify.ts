// Verify as a task app on the task app framework (src/task-app/), started
// only by `start:verify`:
//
//   node verify.mjs --config BUDDY_FILE --issue OWNER/REPO#N
//
// Its work checks the open PR from the issue's branch at the head it has
// when the run starts. It runs the repository's full checks on that head,
// reviews it in one read-only Reviewer session, waits for the head's
// required CI and then submits one GitHub review on that head through the
// buddy's own account: an approval when nothing but nits was found, and a
// request for changes otherwise. A Security finding always blocks, and so
// do failing checks and failing CI. The review is Verify's result; the run
// then reports it on the issue.
//
// GitHub is the whole record. If the buddy's account already approved or
// requested changes on the current head, a rerun submits no second review
// and reports that one instead; a review of an earlier head doesn't count.
// GitHub doesn't let a PR's author review it, so the run fails at once
// when the buddy's account opened the PR. A run that can't judge the head,
// because it moved, its checks couldn't run or its review session failed,
// submits nothing and fails, and a new start retries it.
import { z } from "zod";
import type { Config } from "../config.ts";
import { loadConfig } from "../config.ts";
import { changedFiles, runChecks } from "../ops/checks.ts";
import type { ReviewCounts, ReviewFinding } from "../ops/verify-review.ts";
import { commentable, planReview } from "../ops/verify-review.ts";
import { OpsError } from "../ops-error.ts";
import type { PullRequest, Review } from "../task-app/recovery.ts";
import { Stopped } from "../task-app/stopped.ts";
import type { TaskApp, TaskRun } from "../task-app/task-app.ts";
import { main } from "../task-app/task-app.ts";
import { changeBase } from "./change-base.ts";
import type { HeadCheckout } from "./head-checkout.ts";
import {
  checkoutState,
  commitOf,
  openHeadCheckout,
  removeHeadCheckout,
  trackedChanges,
} from "./head-checkout.ts";
import type { Submitted } from "./submit-review.ts";
import { submitReview } from "./submit-review.ts";
import type { CiVerdict } from "./verify-ci.ts";
import { requiredCi } from "./verify-ci.ts";
import { reviewSession } from "./verify-session.ts";

const TASK = "verify";
const CI_PAUSE_MS = 30_000;
const MS_PER_MINUTE = 60_000;
const SHORT_SHA = 12;
// How long Verify waits for required CI, from the repository config.
const CI_SETTINGS = z.looseObject({ ciWaitMinutes: z.number().positive() });
// The review states that judge a head; a comment or a dismissed review
// doesn't.
const JUDGING: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED"]);

function same(login: string | null, account: string): boolean {
  return login?.toLowerCase() === account.toLowerCase();
}

function code(text: string): string {
  return `\`${text}\``;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function counted(count: number, what: string): string {
  if (count === 1) {
    return `1 ${what}`;
  }
  return `${String(count)} ${what}s`;
}

// The issue's open PR, which Verify reviews.
function openPull(run: TaskRun): PullRequest {
  const pull = run.recovery.pullRequest();
  if (pull === null) {
    throw new OpsError(
      `#${run.issue.number} has no PR from its branch to review`,
    );
  }
  if (pull.state !== "OPEN") {
    throw new OpsError(`PR #${pull.number} is ${pull.state}, not open`);
  }
  return pull;
}

// The review the buddy's account already submitted on `head`, if any.
function ownReview(
  pull: PullRequest,
  account: string,
  head: string,
): Review | undefined {
  return pull.reviews.find(
    (review) =>
      same(review.author, account) &&
      review.commit === head &&
      JUDGING.has(review.state),
  );
}

function linkOf(run: TaskRun, pull: number, review: number): string {
  return `https://github.com/${run.issue.repo}/pull/${pull}#pullrequestreview-${review}`;
}

// Reports review `review` of `head` on the issue, with what to do next.
function report(
  run: TaskRun,
  pull: number,
  head: string,
  review: { submitted: Submitted; text: string },
): void {
  const { submitted, text } = review;
  let next = `To answer it, apply ${code("start:fix")}.`;
  if (submitted.state === "APPROVED") {
    next = `To land it, apply ${code("start:land")}.`;
  }
  run.comment(`${text} ${next}`, "review", {
    pr: pull,
    review: submitted.id,
    head,
    state: submitted.state,
  });
}

function reportEarlier(
  run: TaskRun,
  pull: number,
  head: string,
  review: Review,
): void {
  let judged = "requested changes";
  if (review.state === "APPROVED") {
    judged = "approved it";
  }
  report(run, pull, head, {
    submitted: { id: review.id, state: review.state },
    text: `Verify already reviewed ${code(head.slice(0, SHORT_SHA))} and ${judged}: ${linkOf(run, pull, review.id)}. A rerun submits no second review of the same head.`,
  });
}

function verdictText(head: string, counts: ReviewCounts): string {
  const nits = counted(counts.nits, "nit");
  const short = code(head.slice(0, SHORT_SHA));
  if (counts.blocking === 0) {
    return `Verify approved ${short} with ${nits}`;
  }
  let security = "";
  if (counts.security) {
    security = ", a Security finding among them,";
  }
  return `Verify requested changes on ${short}: ${counted(counts.blocking, "blocking finding")}${security} and ${nits}`;
}

// The checks' and CI's failures, each a change the head needs.
function failureFindings(
  head: string,
  failedChecks: readonly string[],
  ci: CiVerdict,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (failedChecks.length > 0) {
    findings.push({
      body: `The full checks failed on ${head}: ${failedChecks.join(", ")}.`,
      blocking: true,
      security: false,
    });
  }
  if (ci.state === "failing") {
    findings.push({
      body: `Required CI failed on ${head}: ${ci.failing.join(", ")}.`,
      blocking: true,
      security: false,
    });
  }
  return findings;
}

// Runs the repository's full checks on the checkout's head and returns the
// checks that failed. Checks whose setup fails, or that change tracked
// files, judge nothing.
function fullChecks(
  run: TaskRun,
  cfg: Config,
  checkout: HeadCheckout,
  base: string,
): string[] {
  const { head, repo } = checkout;
  const checked = runChecks(cfg, run.issue.number, {
    dir: repo,
    sha: head,
    changed: changedFiles(repo, changeBase(repo, base, head), head),
    keepTracked: true,
  });
  if (checked.checks.some((check) => check.id === "setup" && !check.pass)) {
    throw new OpsError(`the configured setup failed on ${head}`);
  }
  const tracked = trackedChanges(checkout);
  if (tracked !== "") {
    throw new OpsError(
      `the checks changed tracked files on ${head}: ${tracked.split("\n").join("; ")}`,
    );
  }
  return checked.checks.filter((check) => !check.pass).map((check) => check.id);
}

// Judges `head` in `checkout` and submits its review, unless the buddy's
// account reviewed it meanwhile.
async function judge(
  run: TaskRun,
  cfg: Config,
  pull: PullRequest,
  checkout: HeadCheckout,
): Promise<void> {
  const { head } = checkout;
  const base = commitOf(checkout, `origin/${cfg.baseBranch}`);
  const failedChecks = fullChecks(run, cfg, checkout, base);
  run.checkStop();
  const before = checkoutState(checkout);
  const reply = await reviewSession({
    cfg,
    issue: run.issue.number,
    run: run.run,
    checkout,
    base,
  });
  if (checkoutState(checkout) !== before) {
    throw new OpsError(
      "the read-only review session changed its checkout, so it reviewed nothing",
    );
  }
  run.checkStop();
  const ci = await requiredCi({
    head,
    read: () => run.recovery.pullRequest(),
    requireCi: cfg.requireCi,
    pauseMs: CI_PAUSE_MS,
    limitMs: CI_SETTINGS.parse(cfg).ciWaitMinutes * MS_PER_MINUTE,
    sleep: wait,
    checkStop: run.checkStop,
  });
  const earlier = ownReview(ci.pull, run.account, head);
  if (earlier !== undefined) {
    reportEarlier(run, pull.number, head, earlier);
    return;
  }
  const findings: ReviewFinding[] = [
    ...reply.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: finding.body,
      blocking: finding.severity === "blocking",
      security: finding.security,
    })),
    ...failureFindings(head, failedChecks, ci),
  ];
  const ranges = commentable(
    checkout.repo,
    changeBase(checkout.repo, base, head),
    head,
  );
  const planned = planReview(run.run, reply.summary, findings, ranges);
  const submitted = submitReview(run.github, {
    repo: run.issue.repo,
    pull: pull.number,
    head,
    planned,
  });
  report(run, pull.number, head, {
    submitted,
    text: `${verdictText(head, planned.counts)}: ${linkOf(run, pull.number, submitted.id)}.`,
  });
}

async function work(run: TaskRun): Promise<void> {
  const pull = openPull(run);
  const head = pull.headSha;
  const earlier = ownReview(pull, run.account, head);
  if (earlier !== undefined) {
    reportEarlier(run, pull.number, head, earlier);
    return;
  }
  if (same(pull.author, run.account)) {
    throw new OpsError(
      `@${run.account} opened PR #${pull.number}, and GitHub doesn't let a PR's author review it; run Verify as a buddy with another account`,
    );
  }
  const cfg = loadConfig(run.config);
  if (cfg.laneSlots !== undefined) {
    throw new OpsError(
      "Verify's task app takes no lane slot, so it can't run checks for a repository config with laneSlots",
    );
  }
  const checkout = openHeadCheckout(cfg, run.issue.number, {
    task: TASK,
    run: run.run,
    head,
  });
  try {
    await judge(run, cfg, pull, checkout);
  } catch (error: unknown) {
    if (error instanceof Stopped) {
      removeHeadCheckout(checkout);
      throw error;
    }
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    throw new OpsError(
      `${reason}. Its checkout is kept in ${checkout.folder} in the pipeline's job folders`,
      { cause: error },
    );
  }
  removeHeadCheckout(checkout);
}

const VERIFY: TaskApp = { id: TASK, work };

await main(VERIFY);
