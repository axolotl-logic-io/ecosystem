// The usage log's comments: one per issue, or more once one is full, each a
// visible line, its usage mark (src/comments.ts) and a hidden block of
// record lines (usage-log.ts). This module alone owns that format and
// GitHub's size limit. It does no I/O.

import { USAGE_MARK } from "../comment-marks.ts";
import { usageMark } from "../comments.ts";

// GitHub refuses a comment longer than this.
const COMMENT_LIMIT = 65_536;
const VISIBLE_LINE =
  "Issue pipeline usage records (hidden; described in the issue pipeline's docs/reference/)";
const BLOCK_START = "<!--";
// What ends the hidden block, so no record line may hold it.
const BLOCK_END = "-->";

// The body of issue `issue`'s n-th usage comment, holding `lines`.
function usageBody(issue: number, n: number, lines: readonly string[]): string {
  const records = lines.map((line) => `${line}\n`).join("");
  return `${VISIBLE_LINE}\n${usageMark(issue, n)}\n${BLOCK_START}\n${records}${BLOCK_END}`;
}

// The record lines of a usage comment's body.
function usageLines(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.indexOf(BLOCK_START);
  const end = lines.lastIndexOf(BLOCK_END);
  if (start < 0 || end < start) {
    return [];
  }
  return lines.slice(start + 1, end).filter((line) => line.trim() !== "");
}

// The usage comment `body` with `line` appended, or null when that would
// pass GitHub's limit or `body` carries no usage mark.
function appendedBody(body: string, line: string): string | null {
  const groups = USAGE_MARK.exec(body)?.groups;
  if (groups === undefined) {
    return null;
  }
  const { issue = "", n = "1" } = groups;
  const next = usageBody(Number(issue), Number(n), [...usageLines(body), line]);
  if (next.length > COMMENT_LIMIT) {
    return null;
  }
  return next;
}

export { appendedBody, BLOCK_END, usageBody, usageLines };
