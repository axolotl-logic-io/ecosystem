// Land, as a task app: it merges the issue's pull request (PR) and closes
// the issue. Only `start:land` starts it:
//
//   node land.mjs --config BUDDY_FILE --issue OWNER/REPO#N
//
// Land reads every prerequisite from GitHub on the PR's current head when
// it runs: an approval on that head from an account with write access,
// which Verify's account has, no standing request for changes on it from
// one, green required CI on it and a head that contains the PR's base.
// When any is missing, the run merges nothing and fails, and its end
// comment names each one. A PR that conflicts with its base isn't merged:
// Land marks it a draft and posts a comment naming `start:fix`.
//
// Land merges with `gh pr merge PR --merge --match-head-commit HEAD`, so
// GitHub refuses the merge if the head moved after Land read it. It never
// squashes, rebases or bypasses protection. Then it closes the issue if
// the merge didn't. GitHub is the whole record: a run that finds the PR
// merged only closes the issue if it's still open, so nothing merges
// twice, and a merge whose response was lost is settled by reading the
// PR's merged state.

import {
  branchName,
  type Check,
  type PullRequest,
  type Review,
} from "@ecosystem/task-runtime/issue/recovery";
import { z } from "zod";
import { main, type TaskRun } from "../task-app/task-app.ts";

const PULL = z.looseObject({
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  mergeable: z.string(),
  mergeCommit: z.looseObject({ oid: z.string() }).nullable(),
});
const PERMISSION = z.looseObject({ permission: z.string() });
const COMPARE = z.looseObject({ behind_by: z.number().int().nonnegative() });
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set([
  "admin",
  "maintain",
  "write",
]);
// The review states that set where a reviewer stands; a comment doesn't.
const STANDING_STATES: ReadonlySet<string> = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);
const GREEN_BUCKETS: ReadonlySet<string> = new Set(["pass", "skipping"]);

type Pull = z.output<typeof PULL>;
// A review that stands on the head, by an account with write access.
interface Standing {
  author: string;
  state: string;
}

function code(text: string): string {
  return `\`${text}\``;
}

// PR `number` as GitHub reads it now.
function pullNow(run: TaskRun, number: number): Pull {
  return PULL.parse(
    run.github.readJson([
      "pr",
      "view",
      String(number),
      "-R",
      run.issue.repo,
      "--json",
      "state,isDraft,headRefOid,baseRefName,mergeable,mergeCommit",
    ]),
  );
}

function canWrite(run: TaskRun, login: string): boolean {
  const read = run.github.readJson([
    "api",
    `repos/${run.issue.repo}/collaborators/${encodeURIComponent(login)}/permission`,
  ]);
  if (read === null) {
    return false;
  }
  return WRITE_PERMISSIONS.has(PERMISSION.parse(read).permission);
}

// Each reviewer's latest approval, request for changes or dismissal, when
// it was submitted on `head` and the reviewer has write access. GitHub
// lists reviews oldest first.
function standingOn(
  run: TaskRun,
  reviews: readonly Review[],
  head: string,
): Standing[] {
  const latest = new Map<string, Review & { author: string }>();
  for (const review of reviews) {
    const { author } = review;
    if (author !== null && STANDING_STATES.has(review.state)) {
      latest.set(author.toLowerCase(), { ...review, author });
    }
  }
  return [...latest.values()]
    .filter((review) => review.commit === head && review.state !== "DISMISSED")
    .filter((review) => canWrite(run, review.author))
    .map((review) => ({ author: review.author, state: review.state }));
}

function ciMissing(checks: readonly Check[], head: string): string | null {
  if (checks.length === 0) {
    return `green required CI on ${code(head)}: no required check reports on it`;
  }
  const unmet = checks.filter((check) => !GREEN_BUCKETS.has(check.bucket));
  if (unmet.length === 0) {
    return null;
  }
  const states = unmet.map((check) => `${check.name} is ${check.bucket}`);
  return `green required CI on ${code(head)}: ${states.join(", ")}`;
}

function containsBase(run: TaskRun, base: string, head: string): boolean {
  const compared = COMPARE.parse(
    run.github.readJson([
      "api",
      `repos/${run.issue.repo}/compare/${encodeURIComponent(base)}...${head}`,
    ]),
  );
  return compared.behind_by === 0;
}

// The prerequisites PR `pr`, whose head GitHub reads as `now`, is missing.
function missing(run: TaskRun, pr: PullRequest, now: Pull): string[] {
  const head = pr.headSha;
  const reasons: string[] = [];
  if (now.isDraft) {
    reasons.push(`a PR that is ready for review: PR #${pr.number} is a draft`);
  }
  const standing = standingOn(run, pr.reviews, head);
  if (!standing.some((review) => review.state === "APPROVED")) {
    reasons.push(
      `an approval on ${code(head)} from Verify's account or a person with write access`,
    );
  }
  for (const review of standing) {
    if (review.state === "CHANGES_REQUESTED") {
      reasons.push(
        `no standing request for changes on ${code(head)}: @${review.author} requested changes`,
      );
    }
  }
  const ci = ciMissing(pr.checks, head);
  if (ci !== null) {
    reasons.push(ci);
  }
  if (!containsBase(run, now.baseRefName, head)) {
    reasons.push(
      `a head that contains ${code(now.baseRefName)}: apply ${code("start:fix")} to merge it in`,
    );
  } else if (!now.isDraft && now.mergeable !== "MERGEABLE") {
    reasons.push(
      `a PR GitHub reads as mergeable: it reads ${now.mergeable}, so try again shortly`,
    );
  }
  return reasons;
}

// Marks the conflicting PR `pr` a draft, so it goes to Fix.
function markConflict(run: TaskRun, pr: number, now: Pull): void {
  const args = ["pr", "ready", String(pr), "-R", run.issue.repo, "--undo"];
  const result = run.github.writeResult(args);
  if (!pullNow(run, pr).isDraft) {
    throw run.github.failure(args, result);
  }
  run.comment(
    `PR #${pr} conflicts with ${code(now.baseRefName)} at ${code(now.headRefOid)}, so Land didn't merge it and marked it as a draft. To resolve the conflict, apply ${code("start:fix")}.`,
    "conflict",
    { pr, head: now.headRefOid, base: now.baseRefName },
  );
}

// Closes the issue unless it already reads closed: GitHub closes it when
// the PR's body names it with a closing keyword.
function closeIssue(run: TaskRun): boolean {
  if (run.recovery.issue().state !== "open") {
    return false;
  }
  const { repo, number } = run.issue;
  const args = [
    "issue",
    "close",
    String(number),
    "-R",
    repo,
    "--reason",
    "completed",
  ];
  const result = run.github.writeResult(args);
  if (run.recovery.issue().state === "open") {
    throw run.github.failure(args, result);
  }
  return true;
}

// Settles merged PR `pr`, which this run merged when `merged`: says so,
// then closes the issue if it's still open.
function settleMerged(
  run: TaskRun,
  pr: number,
  now: Pull,
  merged: boolean,
): void {
  const commit = now.mergeCommit?.oid ?? "an unknown commit";
  const into = `into ${code(now.baseRefName)} as ${code(commit)}`;
  const payload = { pr, head: now.headRefOid, mergeCommit: commit };
  if (merged) {
    run.comment(
      `Merged PR #${pr} at ${code(now.headRefOid)} ${into}.`,
      "merged",
      payload,
    );
  }
  if (closeIssue(run) && !merged) {
    run.comment(
      `PR #${pr} was already merged ${into}, so Land didn't merge it again. It closed #${run.issue.number}, which was still open.`,
      "merged",
      payload,
    );
  }
}

// The one merge of PR `pr` at exactly `head`. GitHub's reads after it say
// what happened, whatever gh answered.
function mergeAt(run: TaskRun, pr: number, head: string): void {
  const args = [
    "pr",
    "merge",
    String(pr),
    "-R",
    run.issue.repo,
    "--merge",
    "--match-head-commit",
    head,
  ];
  const result = run.github.writeResult(args);
  const now = pullNow(run, pr);
  if (now.state === "MERGED") {
    settleMerged(run, pr, now, true);
    return;
  }
  if (
    now.state === "OPEN" &&
    now.headRefOid === head &&
    now.mergeable === "CONFLICTING"
  ) {
    markConflict(run, pr, now);
    return;
  }
  if (result.code === 0) {
    throw new Error(`gh merged PR #${pr}, but GitHub reads it ${now.state}`);
  }
  throw run.github.failure(args, result);
}

function land(run: TaskRun): void {
  const { number } = run.issue;
  const pr = run.recovery.pullRequest();
  if (pr === null) {
    throw new Error(`#${number} has no PR from ${code(branchName(number))}`);
  }
  const now = pullNow(run, pr.number);
  if (now.state === "MERGED") {
    settleMerged(run, pr.number, now, false);
    return;
  }
  if (now.state !== "OPEN") {
    throw new Error(`PR #${pr.number} is closed without a merge`);
  }
  if (now.headRefOid !== pr.headSha) {
    throw new Error(
      `PR #${pr.number}'s head moved from ${code(pr.headSha)} to ${code(now.headRefOid)} while Land read it`,
    );
  }
  if (!now.isDraft && now.mergeable === "CONFLICTING") {
    markConflict(run, pr.number, now);
    return;
  }
  const reasons = missing(run, pr, now);
  if (reasons.length > 0) {
    throw new Error(
      `Land didn't merge PR #${pr.number}, because these prerequisites aren't met:\n${reasons.map((reason) => `- ${reason}`).join("\n")}`,
    );
  }
  mergeAt(run, pr.number, pr.headSha);
}

await main({ id: "land", work: land });
