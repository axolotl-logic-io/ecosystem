// Verify as a task app on the task app framework (src/task-app/), started
// only by `start:verify`:
//
//   node verify.mjs --invocation
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

import type {
  DomainOutcome,
  ExecutionContext,
  TaskDefinition,
} from "@ecosystem/task-framework";
import type {
  PullRequest,
  Review,
} from "@ecosystem/task-runtime/issue/recovery";
import { Stopped } from "@ecosystem/task-runtime/issue/stopped";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import type { CiVerdict } from "./ci.ts";
import { requiredCi } from "./ci.ts";
import { VERIFY_REPLY } from "./reply.ts";
import type { PlannedReview, ReviewCounts, ReviewFinding } from "./review.ts";
import { planReview } from "./review.ts";

const verifyInputs = z.strictObject({
  issue: z.strictObject({
    repo: z.string().min(1),
    number: z.number().int().positive(),
  }),
  account: z.string().min(1),
  baseBranch: z.string().min(1),
  testCommand: z.string(),
  model: z.string().min(1),
  requireCi: z.boolean(),
  ciWaitMinutes: z.number().positive(),
});
type VerifyInputs = z.infer<typeof verifyInputs>;
interface HeadCheckout {
  root: string;
  folder: string;
  repo: string;
  head: string;
}
interface Submitted {
  id: number;
  state: string;
}
interface VerifyCapabilities {
  readPull: () => PullRequest | null;
  openCheckout: (head: string) => HeadCheckout;
  removeCheckout: (checkout: HeadCheckout) => void;
  fullChecks: (checkout: HeadCheckout, base: string) => string[];
  checkoutState: (checkout: HeadCheckout) => string;
  baseCommit: (checkout: HeadCheckout) => string;
  reviewSession: (checkout: HeadCheckout, base: string) => Promise<unknown>;
  commentable: (
    checkout: HeadCheckout,
    base: string,
  ) => Map<string, [number, number][]>;
  publishable: (text: string) => string;
  submitReview: (
    pull: number,
    head: string,
    planned: PlannedReview,
  ) => Submitted;
  sleep: (ms: number) => Promise<void>;
  checkStop: () => void;
  report: (body: string, kind: string, payload: object) => void;
}
interface TaskRun extends VerifyInputs, VerifyCapabilities {}

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

function counted(count: number, what: string): string {
  if (count === 1) {
    return `1 ${what}`;
  }
  return `${String(count)} ${what}s`;
}

// The issue's open PR, which Verify reviews.
function openPull(run: TaskRun): PullRequest {
  const pull = run.readPull();
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
  run.report(`${text} ${next}`, "review", {
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

// Judges `head` in `checkout` and submits its review, unless the buddy's
// account reviewed it meanwhile.
async function judge(
  run: TaskRun,
  cfg: VerifyInputs,
  pull: PullRequest,
  checkout: HeadCheckout,
): Promise<void> {
  const { head } = checkout;
  const base = run.baseCommit(checkout);
  const failedChecks = run.fullChecks(checkout, base);
  run.checkStop();
  const before = run.checkoutState(checkout);
  const reply = VERIFY_REPLY.parse(await run.reviewSession(checkout, base));
  if (run.checkoutState(checkout) !== before) {
    throw new OpsError(
      "the read-only review session changed its checkout, so it reviewed nothing",
    );
  }
  run.checkStop();
  const ci = await requiredCi({
    head,
    read: () => run.readPull(),
    requireCi: cfg.requireCi,
    pauseMs: CI_PAUSE_MS,
    limitMs: CI_SETTINGS.parse(cfg).ciWaitMinutes * MS_PER_MINUTE,
    sleep: run.sleep,
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
  const ranges = run.commentable(checkout, base);
  const planned = planReview(reply.summary, findings, ranges, run.publishable);
  run.checkStop();
  const current = run.readPull();
  if (current?.state !== "OPEN" || current.headSha !== head) {
    throw new OpsError("PR head moved before review submission");
  }
  const concurrent = ownReview(current, run.account, head);
  if (concurrent !== undefined) {
    reportEarlier(run, pull.number, head, concurrent);
    return;
  }
  const submitted = run.submitReview(pull.number, head, planned);
  report(run, pull.number, head, {
    submitted,
    text: `${verdictText(head, planned.counts)}: ${linkOf(run, pull.number, submitted.id)}.`,
  });
}

async function work(run: TaskRun): Promise<DomainOutcome<string>> {
  run.checkStop();
  const found = run.readPull();
  if (found?.state !== "OPEN") {
    return { status: "blocked", result: "Verify needs an open PR" };
  }
  const pull = openPull(run);
  const head = pull.headSha;
  const earlier = ownReview(pull, run.account, head);
  if (earlier !== undefined) {
    reportEarlier(run, pull.number, head, earlier);
    return { status: "no-change", result: "Already reviewed this head" };
  }
  if (same(pull.author, run.account)) {
    throw new OpsError(
      `@${run.account} opened PR #${pull.number}, and GitHub doesn't let a PR's author review it; run Verify as a buddy with another account`,
    );
  }
  const cfg = run;
  const checkout = run.openCheckout(head);
  try {
    await judge(run, cfg, pull, checkout);
  } catch (error: unknown) {
    if (error instanceof Stopped) {
      run.removeCheckout(checkout);
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
  run.removeCheckout(checkout);
  return { status: "completed", result: `Reviewed ${head}` };
}

const verify: TaskDefinition<VerifyInputs, VerifyCapabilities, string> = {
  id: TASK,
  inputs: verifyInputs,
  run: async (
    inputs: VerifyInputs,
    capabilities: VerifyCapabilities,
    context: ExecutionContext,
  ): Promise<DomainOutcome<string>> => {
    function checkStop(): void {
      context.checkCancelled();
      capabilities.checkStop();
    }
    return await work({ ...inputs, ...capabilities, checkStop });
  },
};

export type { HeadCheckout, VerifyCapabilities, VerifyInputs };
export { verify, verifyInputs };
