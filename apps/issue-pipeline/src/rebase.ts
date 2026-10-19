// A rebase in a git checkout that a writer may resolve by hand: whether one is
// stopped, which files it left unmerged, and whether a resolved rebase is fit
// to push. Used for the issue's code worktree and for its wiki checkout.

import fs from "node:fs";
import path from "node:path";
import { run } from "./process.ts";
import { tail } from "./shell-command.ts";

const REBASE_DIRS: readonly string[] = ["rebase-merge", "rebase-apply"];
const DIRTY_LINES = 20;
const MARKER_LINES = 10;
const CONFLICT_MARKER = /^\+(?:<{7}|>{7})(?: |$)/u;
const MIDDLE_MARKER = "+=======";

function gitOut(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

function gitSucceeds(dir: string, args: readonly string[]): boolean {
  return run("git", ["-C", dir, ...args], { allowFail: true }).code === 0;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

function rebaseInProgress(dir: string): boolean {
  return REBASE_DIRS.some((name) => {
    const where = gitOut(dir, ["rev-parse", "--git-path", name]).trim();
    return fs.existsSync(path.resolve(dir, where));
  });
}

// Drops a stopped rebase, if there is one.
function abortRebase(dir: string): void {
  if (rebaseInProgress(dir)) {
    run("git", ["-C", dir, "rebase", "--abort"]);
  }
}

// The files a stopped rebase left unmerged.
function unmergedFiles(dir: string): string[] {
  const unmerged = ["-C", dir, "diff", "--name-only", "--diff-filter=U"];
  return nonEmptyLines(run("git", unmerged, { allowFail: true }).stdout);
}

function isMarker(line: string): boolean {
  return CONFLICT_MARKER.test(line) || line === MIDDLE_MARKER;
}

// Why the checkout's commits can't be pushed as rebased onto `base`, if they can't.
function commitsProblem(dir: string, base: string): string | undefined {
  if (!gitSucceeds(dir, ["merge-base", "--is-ancestor", base, "HEAD"])) {
    return `HEAD is not based on ${base}`;
  }
  const count = gitOut(dir, ["rev-list", "--count", `${base}..HEAD`]);
  if (!(Number(count.trim()) > 0)) {
    return "the branch has no commits left after the rebase";
  }
  const diff = gitOut(dir, ["diff", `${base}...HEAD`, "-U0"]);
  const markers = diff.split("\n").filter(isMarker);
  if (markers.length > 0) {
    const shown = markers.slice(0, MARKER_LINES).join("\n");
    return `conflict markers remain:\n${shown}`;
  }
  return undefined;
}

// Why a writer's resolved rebase onto `base` can't be pushed, or undefined when
// it can: the rebase finished, the checkout is clean, HEAD has commits on top
// of `base`, and no conflict marker is left.
function rebaseProblem(dir: string, base: string): string | undefined {
  if (rebaseInProgress(dir)) {
    return "the rebase was not finished";
  }
  const dirty = gitOut(dir, ["status", "--porcelain"]).trim();
  if (dirty !== "") {
    const shown = tail(dirty, DIRTY_LINES);
    return `the worktree has uncommitted changes:\n${shown}`;
  }
  return commitsProblem(dir, base);
}

export { abortRebase, rebaseInProgress, rebaseProblem, unmergedFiles };
