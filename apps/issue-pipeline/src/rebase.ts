// Rebase state and finish checks for code and wiki checkouts. Code continuation
// additionally owns gitlink classification and its exact-target wiki pointer;
// writers stage text, never select wiki revisions.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import { wikiCfg } from "./config.ts";
import { OpsError } from "./ops-error.ts";
import { run, tail } from "./process.ts";
import { holdWikiPin } from "./wiki.ts";

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

const COMMIT_SHA = /^[0-9a-f]{40,64}$/u;
const SHA = z.string().regex(COMMIT_SHA);
const SYNC = z.object({ from: SHA, onto: SHA, wikiResolved: z.boolean() });
type CodeSync = z.infer<typeof SYNC>;
const ENTRY =
  /^(?<mode>\d{6}) (?<sha>[0-9a-f]{40,64}) (?<stage>[123])\t(?<file>[\s\S]+)$/u;

interface Stage {
  mode: string;
  sha: string;
  stage: string;
  file: string;
}

function syncFile(wt: string): string {
  return path.resolve(
    wt,
    gitOut(wt, ["rev-parse", "--git-path", "pipeline-code-sync.json"]).trim(),
  );
}

function readCodeSync(wt: string): CodeSync | undefined {
  const file = syncFile(wt);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  return SYNC.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

function saveCodeSync(wt: string, sync: CodeSync): void {
  fs.writeFileSync(syncFile(wt), JSON.stringify(sync));
}

function clearCodeSync(wt: string): void {
  fs.rmSync(syncFile(wt), { force: true });
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

// Refuse unsupported gitlinks before touching any entry. Type conflicts, even
// at the wiki path, are not eligible for the automatic exception.
function resolveWikiConflict(cfg: Config, wt: string, sync: CodeSync): void {
  const entries = conflictStages(wt);
  const links = new Set(
    entries
      .filter((entry) => entry.mode === "160000")
      .map((entry) => entry.file),
  );
  const wiki = wikiCfg(cfg);
  for (const file of links) {
    const stages = entries.filter((entry) => entry.file === file);
    const evidence = stages
      .map((entry) => `stage ${entry.stage}: ${entry.sha} (mode ${entry.mode})`)
      .join(", ");
    const bothPins =
      stages.some((entry) => entry.stage === "2") &&
      stages.some((entry) => entry.stage === "3");
    if (
      wiki?.dir !== file ||
      !bothPins ||
      stages.some((entry) => entry.mode !== "160000")
    ) {
      throw new OpsError(
        `unsupported gitlink conflict at ${JSON.stringify(file)}; ${evidence}; retaining unresolved checkout`,
      );
    }
    const tree = gitOut(wt, ["ls-tree", sync.onto, "--", file]).trim();
    if (!tree.startsWith("160000 commit ")) {
      throw new OpsError(
        `synchronization target ${sync.onto} has no wiki gitlink at ${JSON.stringify(file)}; ${evidence}; retaining unresolved checkout`,
      );
    }
  }
  if (wiki === null || !links.has(wiki.dir)) {
    return;
  }
  const pin = gitOut(wt, ["rev-parse", `${sync.onto}:${wiki.dir}`]).trim();
  run("git", [
    "-C",
    wt,
    "update-index",
    "--add",
    "--cacheinfo",
    "160000",
    pin,
    wiki.dir,
  ]);
  sync.wikiResolved = true;
  saveCodeSync(wt, sync);
  holdWikiPin(cfg, wt);
}

// Classify the actual checkout against its recorded synchronization, including
// a stop reached by a session's own continuation or one being rejected. A
// requested target must match while stopped; completed work has finish checks.
function classifyCodeSync(
  cfg: Config,
  wt: string,
  target: string | null | undefined,
): CodeSync | undefined {
  const sync = readCodeSync(wt);
  if (sync === undefined) {
    return undefined;
  }
  if (
    rebaseInProgress(wt) &&
    target !== undefined &&
    target !== null &&
    target !== sync.onto
  ) {
    throw new OpsError(
      "finish-sync target differs from the stopped code rebase",
    );
  }
  resolveWikiConflict(cfg, wt, sync);
  return sync;
}

// Continue only once all text at a stop has been staged. Every subsequent
// stop is classified too; a writer never selects or stages a wiki revision.
function continueCodeSync(cfg: Config, wt: string, sync: CodeSync): void {
  while (rebaseInProgress(wt)) {
    resolveWikiConflict(cfg, wt, sync);
    if (unmergedFiles(wt).length > 0) {
      return;
    }
    const result = run(
      "git",
      ["-C", wt, "-c", "core.editor=true", "rebase", "--continue"],
      { allowFail: true },
    );
    holdWikiPin(cfg, wt);
    if (result.code !== 0 && unmergedFiles(wt).length === 0) {
      throw new OpsError(
        `code rebase continuation failed; retaining checkout: ${result.stderr}`,
      );
    }
  }
}

export type { CodeSync };
export {
  abortRebase,
  classifyCodeSync,
  clearCodeSync,
  conflictStages,
  continueCodeSync,
  readCodeSync,
  rebaseInProgress,
  rebaseProblem,
  saveCodeSync,
  unmergedFiles,
};
