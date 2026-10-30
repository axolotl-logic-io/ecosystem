// A checkout's uncommitted changes saved before a stage job drops them
// (dropped-changes-saved, #369). Each inert patch names its base commit and
// carries the binary-safe diff of staged, unstaged and untracked files, less
// ignored files. Preparing it never changes the source checkout or its index.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import { run } from "../command.ts";

interface PreparedPatch {
  lost: string[];
  files: string[];
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

// Each patch independently restores its snapshot on HEAD. The index patch
// precedes the worktree overlay, so divergent staged bytes cannot disappear.
function writePatch(
  dir: string,
  indexFile: string,
  to: { file: string; title: string },
  temp: string,
): boolean {
  if (!stagedDiffers(dir, indexFile)) {
    return false;
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
  const base = gitIn(dir, ["rev-parse", "HEAD"], indexFile).trim();
  let kind = "working-tree";
  if (to.file.endsWith(".index.patch")) {
    kind = "index";
  }
  const header = [
    to.title,
    `Base: ${base}`,
    `Snapshot: ${kind}`,
    `To restore: check out ${base}, then run git apply --index ${path.basename(to.file)}`,
    "",
    "",
  ].join("\n");
  fs.writeFileSync(
    to.file,
    Buffer.concat([Buffer.from(header), fs.readFileSync(temp)]),
    { flag: "wx" },
  );
  return true;
}

// Uses only a copy of the actual index. Existing artifacts are never
// overwritten; an unmerged index or preparation error retains the checkout.
function saveDroppedPatch(
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
    if (gitIn(dir, ["ls-files", "--unmerged"], indexFile).trim() !== "") {
      throw new OpsError(
        `unmerged index in ${dir}; retain the original checkout for recovery`,
      );
    }
    const lost = changedPaths(dir, indexFile);
    const files: string[] = [];
    const staged = {
      file: `${to.file}.index.patch`,
      title: `${to.title} (index snapshot)`,
    };
    if (writePatch(dir, indexFile, staged, temp)) {
      files.push(staged.file);
    }
    gitIn(dir, ["add", "-A"], indexFile);
    if (writePatch(dir, indexFile, to, temp)) {
      files.push(to.file);
    }
    return { lost, files };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const PATCH_FILE = /^[a-zA-Z0-9-]+-repo\.patch(?:\.index\.patch)?$/u;
const BASE = /^[0-9a-f]{40}$/u;
const SNAPSHOT = z.object({
  file: z.string().regex(PATCH_FILE),
  checkout: z.literal("repo"),
  source: z.string(),
  kind: z.enum(["index", "working-tree"]),
  base: z.string().regex(BASE),
});
const ORIGIN = z.object({
  stage: z.string(),
  outcome: z.string(),
  reason: z.string().nullable(),
});
const MANIFEST = z.object({
  version: z.literal(1),
  repo: z.string(),
  issue: z.number().int(),
  branch: z.string(),
  job: z.string(),
  origin: ORIGIN,
  snapshots: z.array(SNAPSHOT),
});
type RecoveryOrigin = z.infer<typeof ORIGIN>;
type RecoverySnapshot = z.infer<typeof SNAPSHOT>;
type RecoveryManifest = z.infer<typeof MANIFEST>;

function recoveryDir(artifacts: string): string {
  return path.join(artifacts, "dropped");
}

// Exclusive creation is intentional: a collision or write failure must retain
// the original checkout, just like a failed patch save.
function saveRecovery(artifacts: string, manifest: RecoveryManifest): void {
  const dir = recoveryDir(artifacts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${manifest.job}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
}

export type { RecoveryOrigin, RecoverySnapshot };
export { MANIFEST, saveDroppedPatch, saveRecovery };
