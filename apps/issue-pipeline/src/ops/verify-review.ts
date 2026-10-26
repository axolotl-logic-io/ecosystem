// The GitHub review Verify submits on one exact PR head through the landing
// account, and how a later read finds it again. A finding about lines the
// PR's diff shows becomes an inline comment on them; every other finding goes
// in the review body. Each finding says whether it blocks: a nit doesn't, and
// a Security finding always does. The review approves when nothing blocks and
// requests changes otherwise, and it binds the head through its `commit_id`.
//
// The body ends with a mark naming the Verify run that submitted it and
// what it counted, so a read-only reconciliation finds exactly that run's
// review and never submits a second one.

import { z } from "zod";
import type { Config } from "../config.ts";
import { wire } from "../discovery/wire.ts";
import type { PrReview } from "../domain.ts";
import { REVIEW_STATE, SHA, UUID } from "../domain.ts";
import { gh } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { redactLocalPaths } from "../pipeline-root.ts";
import type { SubmittedReview } from "../pr-reviews.ts";
import { listReviews } from "../pr-reviews.ts";
import { run as runCommand } from "../process.ts";
import { redactAddresses } from "../redact-addresses.ts";
import type { Observation } from "../signals/github-source.ts";

const MARK = "<!-- agent-pipeline:verify-review\n";
const MARK_END = "\n-->";
const COUNT = z.number().int().nonnegative();
const MARKED = z.strictObject({
  run: UUID,
  blocking: COUNT,
  nits: COUNT,
  security: z.boolean(),
});
const SUBMITTED = wire(
  z.looseObject({
    id: z.number().int().positive(),
    state: REVIEW_STATE,
    commitId: SHA,
  }),
);
const CAPITAL = /(?<letter>[A-Z])/gu;
const DIFF_FILE = /^\+\+\+ b\/(?<path>.+)$/u;
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/u;
// GitHub refuses a review body or comment over 65536 characters.
const MAX_BODY = 60_000;

// One finding the review reports: about `path` and `line` when it names
// both, else about the change as a whole.
interface ReviewFinding {
  path?: string | undefined;
  line?: number | undefined;
  body: string;
  blocking: boolean;
  security: boolean;
}

// What the review counts: its blocking findings, its nits, and whether a
// Security finding was among the blocking ones.
type ReviewCounts = Omit<z.infer<typeof MARKED>, "run">;

// The review Verify will submit, before it is submitted.
interface PlannedReview {
  event: "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: { path: string; line: number; body: string }[];
  counts: ReviewCounts;
}

// A review the landing account submitted for a Verify run, as GitHub
// reports it now, with the counts its mark keeps.
interface PostedReview {
  review: SubmittedReview;
  counts: ReviewCounts;
}

// Each changed file's line ranges on the head's side of the diff from
// `base` to `code`: the lines GitHub lets a review comment on.
function commentable(
  clone: string,
  base: string,
  code: string,
): Map<string, [number, number][]> {
  const ranges = new Map<string, [number, number][]>();
  const diff = runCommand(
    "git",
    ["-C", clone, "diff", "--no-color", "--unified=3", base, code],
    { allowFail: true },
  );
  if (diff.code !== 0) {
    return ranges;
  }
  let file: string | null = null;
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      const { path = null } = DIFF_FILE.exec(line)?.groups ?? {};
      file = path;
    }
    const { start, count = "1" } = DIFF_HUNK.exec(line)?.groups ?? {};
    if (file !== null && start !== undefined && Number(count) > 0) {
      const first = Number(start);
      const found = ranges.get(file) ?? [];
      found.push([first, first + Number(count) - 1]);
      ranges.set(file, found);
    }
  }
  return ranges;
}

// Text a person may read on GitHub: no local paths or addresses, and short
// enough for GitHub to take.
function publishable(text: string): string {
  return redactAddresses(redactLocalPaths(text)).slice(0, MAX_BODY);
}

type Label =
  | "**Security (blocking)**"
  | "**Blocking**"
  | "**Nit (non-blocking)**";

function labelOf(finding: ReviewFinding): Label {
  if (finding.security) {
    return "**Security (blocking)**";
  }
  if (finding.blocking) {
    return "**Blocking**";
  }
  return "**Nit (non-blocking)**";
}

function generalLine(finding: ReviewFinding): string {
  if (finding.path === undefined) {
    return `- ${labelOf(finding)}: ${finding.body}`;
  }
  let where = finding.path;
  if (finding.line !== undefined) {
    where = `${finding.path}:${String(finding.line)}`;
  }
  return `- ${labelOf(finding)} \`${where}\`: ${finding.body}`;
}

function inDiff(
  finding: ReviewFinding,
  ranges: ReadonlyMap<string, readonly [number, number][]>,
): finding is ReviewFinding & { path: string; line: number } {
  const { path, line } = finding;
  if (path === undefined || line === undefined) {
    return false;
  }
  return (ranges.get(path) ?? []).some(
    ([first, last]) => line >= first && line <= last,
  );
}

function countsOf(findings: readonly ReviewFinding[]): ReviewCounts {
  const blocking = findings.filter(
    (finding) => finding.blocking || finding.security,
  );
  return {
    blocking: blocking.length,
    nits: findings.length - blocking.length,
    security: blocking.some((finding) => finding.security),
  };
}

// The review of `findings` that Verify run `run` submits: approving only
// when none of them blocks.
function planReview(
  run: string,
  summary: string,
  findings: readonly ReviewFinding[],
  ranges: ReadonlyMap<string, readonly [number, number][]>,
): PlannedReview {
  const counts = countsOf(findings);
  const inline = findings.filter((finding) => inDiff(finding, ranges));
  const general = findings.filter((finding) => !inDiff(finding, ranges));
  const listed: string[] = [];
  if (general.length > 0) {
    listed.push("", "Findings:", "", ...general.map(generalLine));
  }
  const mark = `${MARK}${JSON.stringify({ run, ...counts })}${MARK_END}`;
  let event: PlannedReview["event"] = "REQUEST_CHANGES";
  if (counts.blocking === 0) {
    event = "APPROVE";
  }
  return {
    event,
    body: `${publishable([summary, ...listed].join("\n"))}\n\n${mark}`,
    comments: inline.map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: publishable(`${labelOf(finding)}: ${finding.body}`),
    })),
    counts,
  };
}

// `value` with GitHub REST's snake_case keys: the inverse of wire.ts, at the
// same boundary.
function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakeKeys);
  }
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record.data).map(([key, item]) => [
      key.replace(
        CAPITAL,
        (_match: string, letter: string) => `_${letter.toLowerCase()}`,
      ),
      snakeKeys(item),
    ]),
  );
}

// Submits `planned` on PR `pr` against exactly `code`, through the landing
// account. An answer that doesn't confirm that review on that head throws,
// leaving the run for reconciliation.
function submitReview(
  cfg: Config,
  pr: number,
  code: string,
  planned: PlannedReview,
): PrReview {
  const input = JSON.stringify(
    snakeKeys({
      commitId: code,
      event: planned.event,
      body: planned.body,
      comments: planned.comments,
    }),
  );
  const answer = gh(
    cfg,
    "landing",
    [
      "api",
      "-X",
      "POST",
      `repos/${cfg.repo}/pulls/${String(pr)}/reviews`,
      "--input",
      "-",
    ],
    { input, reconciles: true },
  );
  const submitted = SUBMITTED.safeParse(JSON.parse(answer.stdout));
  let expected: PrReview["state"] = "CHANGES_REQUESTED";
  if (planned.event === "APPROVE") {
    expected = "APPROVED";
  }
  if (
    !submitted.success ||
    submitted.data.commitId !== code ||
    submitted.data.state !== expected
  ) {
    throw new OpsError(
      `GitHub's answer doesn't confirm a ${expected} review of ${code} on PR #${String(pr)}`,
    );
  }
  return {
    id: submitted.data.id,
    pr,
    commit: code,
    state: submitted.data.state,
  };
}

function markOf(body: string): z.infer<typeof MARKED> | null {
  const start = body.lastIndexOf(MARK);
  if (start === -1) {
    return null;
  }
  const [json = ""] = body.slice(start + MARK.length).split(MARK_END);
  try {
    return MARKED.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

// The review the landing account submitted on PR `pr` for Verify run
// `run` against exactly `code`, or null when it submitted none.
function postedReview(
  cfg: Config,
  pr: number,
  run: string,
  code: string,
): Observation<PostedReview | null> {
  const reviews = listReviews(cfg, pr);
  if (reviews.status !== "ok") {
    return reviews;
  }
  const landing = cfg.landingAccount.toLowerCase();
  for (const review of reviews.value) {
    const mark = markOf(review.body);
    if (
      review.author?.login.toLowerCase() === landing &&
      review.commit === code &&
      mark?.run === run
    ) {
      const { run: _run, ...counts } = mark;
      return { status: "ok", value: { review, counts } };
    }
  }
  return { status: "ok", value: null };
}

export type { PlannedReview, PostedReview, ReviewCounts, ReviewFinding };
export { commentable, planReview, postedReview, submitReview };
