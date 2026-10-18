// A checkout's uncommitted changes saved before a stage job drops them
// (dropped-changes-saved, #369). Each inert patch names its base commit and
// carries the binary-safe diff of staged, unstaged and untracked files, less
// ignored files. Preparing it never changes the source checkout or its index.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";
import { run } from "../process.ts";
import { holdWikiPin } from "../wiki.ts";

interface PreparedPatch {
  lost: string[];
  saved: boolean;
}

const DIFFERS = 1;
const STATUS_PATH_AT = 3;

function gitIn(
  dir: string,
  args: readonly string[],
  indexFile: string,
): string {
  const env = new Map([["GIT_INDEX_FILE", indexFile]]);
  return run("git", ["-C", dir, ...args], { env }).stdout;
}

function changedPaths(dir: string, indexFile: string): string[] {
  const status = ["status", "--porcelain", "-z", "--untracked-files=all"];
  const entries = gitIn(dir, status, indexFile).split("\0");
  const lost: string[] = [];
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at] ?? "";
    if (entry !== "") {
      lost.push(entry.slice(STATUS_PATH_AT));
    }
    // A rename or copy is followed by the path it came from.
    if (entry.startsWith("R") || entry.startsWith("C")) {
      at += 1;
    }
  }
  return lost;
}

function stagedDiffers(dir: string, indexFile: string): boolean {
  const args = ["-C", dir, "diff", "--cached", "--quiet", "HEAD"];
  const env = new Map([["GIT_INDEX_FILE", indexFile]]);
  const { code } = run("git", args, { allowFail: true, env });
  if (code === 0) {
    return false;
  }
  if (code === DIFFERS) {
    return true;
  }
  throw new Error(`git diff --cached --quiet in ${dir} exited ${code}`);
}

function copyIndex(dir: string, indexFile: string): void {
  const index = run("git", [
    "-C",
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]).stdout.trim();
  if (fs.existsSync(index)) {
    fs.copyFileSync(index, indexFile);
  } else {
    gitIn(dir, ["read-tree", "HEAD"], indexFile);
  }
}

// Uses a copy of the actual index to preserve staged pin changes and index
// flags. A moving wiki checkout is held only in that copy. Existing recovery
// evidence is never overwritten; any error leaves the original checkout intact.
function saveDroppedPatch(
  cfg: Config,
  dir: string,
  to: { file: string; title: string },
): PreparedPatch {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "issue-pipeline-index-"),
  );
  const indexFile = path.join(tempDir, "index");
  const temp = path.join(tempDir, "changes.patch");
  try {
    copyIndex(dir, indexFile);
    holdWikiPin(cfg, dir, indexFile);
    const lost = changedPaths(dir, indexFile);
    const base = gitIn(dir, ["rev-parse", "HEAD"], indexFile).trim();
    gitIn(dir, ["add", "-A"], indexFile);
    if (!stagedDiffers(dir, indexFile)) {
      return { lost, saved: false };
    }
    fs.mkdirSync(path.dirname(to.file), { recursive: true });
    gitIn(
      dir,
      [
        "diff",
        "--cached",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `--output=${temp}`,
        "HEAD",
      ],
      indexFile,
    );
    const header = [
      to.title,
      `Base: ${base}`,
      `To restore: check out ${base}, then run git apply --index ${path.basename(to.file)}`,
      "",
      "",
    ].join("\n");
    fs.writeFileSync(
      to.file,
      Buffer.concat([Buffer.from(header), fs.readFileSync(temp)]),
      { flag: "wx" },
    );
    return { lost, saved: true };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export { saveDroppedPatch };
