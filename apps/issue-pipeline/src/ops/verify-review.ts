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
import { redactLocalPaths } from "../pipeline-root.ts";
import { run as runCommand } from "../process.ts";
import { redactAddresses } from "../redact-addresses.ts";

const MARK = "<!-- agent-pipeline:verify-review\n";
const MARK_END = "\n-->";
const COUNT = z.number().int().nonnegative();
const MARKED = z.strictObject({
  run: z.uuid(),
  blocking: COUNT,
  nits: COUNT,
  security: z.boolean(),
});
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

export type { PlannedReview, ReviewCounts, ReviewFinding };
export { commentable, planReview };
