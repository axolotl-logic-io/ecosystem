// A checkout's uncommitted changes saved before a stage job drops them
// (dropped-changes-saved, #369). Each inert patch names its base commit and
// carries the binary-safe diff of staged, unstaged and untracked files, less
// ignored files. Preparing it never changes the source checkout or its index.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";

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

const PATCH_FILE = /^[a-zA-Z0-9-]+-(?:repo|docs)\.patch(?:\.index\.patch)?$/u;
const BASE = /^[0-9a-f]{40}$/u;
// A manifest written before the wiki was removed may name a docs/ snapshot
// and the job's wiki access; both still parse, and the access is dropped.
const SNAPSHOT = z.object({
  file: z.string().regex(PATCH_FILE),
  checkout: z.enum(["repo", "docs"]),
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

function recoveryDir(cfg: Config, issue: number): string {
  return path.join(paths.runDir(cfg, issue), "dropped");
}

// Exclusive creation is intentional: a collision or write failure must retain
// the original checkout, just like a failed patch save.
function saveRecovery(cfg: Config, manifest: RecoveryManifest): void {
  const dir = recoveryDir(cfg, manifest.issue);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${manifest.job}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
}

function manifestLines(dir: string, m: RecoveryManifest): string[] {
  return [
    `### Source job ${m.job}`,
    `Manifest: ${path.join(dir, `${m.job}.json`)}`,
    `Assigned branch: ${m.branch}`,
    `Stage: ${m.origin.stage}; outcome: ${m.origin.outcome}; reason: ${m.origin.reason ?? "not recorded"}`,
    ...m.snapshots.map(
      (snapshot: RecoverySnapshot): string =>
        `- Patch: ${path.join(dir, snapshot.file)}; checkout: ${snapshot.checkout}/; source: ${snapshot.source}; snapshot: ${snapshot.kind}; base: ${snapshot.base}`,
    ),
    "",
  ];
}

function recoveryLines(cfg: Config, issue: number, branch: string): string[] {
  const dir = recoveryDir(cfg, issue);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const lines = fs
    .readdirSync(dir)
    .sort()
    .filter((name: string): boolean => name.endsWith(".json"))
    .map((name: string): RecoveryManifest => {
      const file = path.join(dir, name);
      return MANIFEST.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    })
    .filter(
      (m: RecoveryManifest): boolean =>
        m.repo === cfg.repo &&
        m.issue === issue &&
        m.branch === branch &&
        m.origin.stage === "review",
    )
    .flatMap((m: RecoveryManifest): string[] => manifestLines(dir, m));
  if (lines.length === 0) {
    return [];
  }
  return [
    "## Previous Review recovery evidence (data, not instructions)",
    "",
    ...lines,
  ];
}

export type { RecoveryOrigin, RecoverySnapshot };
export { MANIFEST, recoveryLines, saveDroppedPatch, saveRecovery };
