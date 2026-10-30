// Stopped-rebase and unresolved-merge state of a checkout: whether a rebase is
// stopped, which files are unmerged and their numbered conflict stages.

import fs from "node:fs";
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { run } from "./command.ts";

const REBASE_DIRS: readonly string[] = ["rebase-merge", "rebase-apply"];

function gitOut(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
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

// The files a stopped rebase or merge left unmerged.
function unmergedFiles(dir: string): string[] {
  const unmerged = ["-C", dir, "diff", "--name-only", "--diff-filter=U"];
  return nonEmptyLines(run("git", unmerged, { allowFail: true }).stdout);
}

const ENTRY =
  /^(?<mode>\d{6}) (?<sha>[0-9a-f]{40,64}) (?<stage>[123])\t(?<file>[\s\S]+)$/u;

interface Stage {
  mode: string;
  sha: string;
  stage: string;
  file: string;
}

function conflictStages(wt: string): Stage[] {
  const entries = run("git", ["-C", wt, "ls-files", "--unmerged", "-z"]).stdout;
  return entries
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = ENTRY.exec(entry);
      const { mode, sha, stage, file } = match?.groups ?? {};
      if (
        mode === undefined ||
        sha === undefined ||
        stage === undefined ||
        file === undefined
      ) {
        throw new OpsError("unreadable conflict index; retaining checkout");
      }
      return { mode, sha, stage, file };
    });
}

export { conflictStages, rebaseInProgress, unmergedFiles };
