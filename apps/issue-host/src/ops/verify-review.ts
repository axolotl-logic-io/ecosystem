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

import { run as runCommand } from "../process.ts";

const DIFF_FILE = /^\+\+\+ b\/(?<path>.+)$/u;
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/u;

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

export { commentable };
