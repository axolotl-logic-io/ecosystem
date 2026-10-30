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

interface ReviewCounts {
  blocking: number;
  nits: number;
  security: boolean;
}
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

// The review Verify will submit, before it is submitted.
interface PlannedReview {
  event: "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: { path: string; line: number; body: string }[];
  counts: ReviewCounts;
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
  summary: string,
  findings: readonly ReviewFinding[],
  ranges: ReadonlyMap<string, readonly [number, number][]>,
  sanitize: (text: string) => string,
): PlannedReview {
  const counts = countsOf(findings);
  const inline = findings.filter((finding) => inDiff(finding, ranges));
  const general = findings.filter((finding) => !inDiff(finding, ranges));
  const listed: string[] = [];
  if (general.length > 0) {
    listed.push("", "Findings:", "", ...general.map(generalLine));
  }
  let event: PlannedReview["event"] = "REQUEST_CHANGES";
  if (counts.blocking === 0) {
    event = "APPROVE";
  }
  return {
    event,
    body: sanitize([summary, ...listed].join("\n")).slice(0, MAX_BODY),
    comments: inline.map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: sanitize(`${labelOf(finding)}: ${finding.body}`).slice(0, MAX_BODY),
    })),
    counts,
  };
}

export type { PlannedReview, ReviewCounts, ReviewFinding };
export { planReview };
