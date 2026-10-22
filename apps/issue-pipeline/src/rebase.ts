// Rebase state and finish checks for the code checkout. Code continuation
// additionally refuses gitlink conflicts: writers stage text, never select a
// submodule's revision.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OpsError } from "./ops-error.ts";
import { run, tail } from "./process.ts";

const REBASE_DIRS: readonly string[] = ["rebase-merge", "rebase-apply"];
const DIRTY_LINES = 20;
const MARKER_LINES = 10;
const CONFLICT_MARKER = /^\+(?:<{7}|>{7})(?: |$)/u;
const MIDDLE_MARKER = "+=======";
const GITLINK = /^160000 commit [0-9a-f]+\t(?<file>[\s\S]+)$/u;

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

// Whether `dir` is a submodule worktree whose repository lives in the
// checkout's own `modules/` folder, with nothing uncommitted in it.
function cleanModuleWorktree(wt: string, dir: string): boolean {
  const gitfile = path.join(dir, ".git");
  if (!(fs.existsSync(gitfile) && fs.statSync(gitfile).isFile())) {
    return false;
  }
  const common = path.resolve(
    wt,
    gitOut(wt, ["rev-parse", "--git-common-dir"]).trim(),
  );
  const own = gitOut(dir, ["rev-parse", "--absolute-git-dir"]).trim();
  const modules = `${fs.realpathSync(path.join(common, "modules"))}${path.sep}`;
  if (!fs.realpathSync(own).startsWith(modules)) {
    return false;
  }
  return gitOut(dir, ["status", "--porcelain"]).trim() === "";
}

// The gitlink paths in commit `rev`'s tree.
function gitlinks(wt: string, rev: string): string[] {
  return gitOut(wt, ["ls-tree", "-r", "-z", rev])
    .split("\0")
    .map((entry) => {
      const { file } = GITLINK.exec(entry)?.groups ?? {};
      return file;
    })
    .filter((file): file is string => file !== undefined);
}

// Whether `file` was a submodule that HEAD no longer has, with a leftover
// worktree that is safe to remove (cleanModuleWorktree).
function retiredWorktree(wt: string, file: string): boolean {
  const dir = path.join(wt, file);
  const tracked = gitOut(wt, ["ls-tree", "HEAD", "--", file]).trim();
  return tracked === "" && fs.existsSync(dir) && cleanModuleWorktree(wt, dir);
}

// Removes the worktree of each submodule that `from` had and the finished
// rebase's HEAD no longer has. A rebase onto a base that removed a submodule
// leaves its folder behind as untracked residue, which no session may clean.
// Only a clean worktree whose repository stays in the checkout's `modules/`
// is removed, so nothing uncommitted is lost. Anything else stays and fails
// the cleanliness check.
function removeRetiredSubmodules(wt: string, from: string): string[] {
  if (rebaseInProgress(wt)) {
    return [];
  }
  const retired = gitlinks(wt, from).filter((file) =>
    retiredWorktree(wt, file),
  );
  for (const file of retired) {
    fs.rmSync(path.join(wt, file), { recursive: true, force: true });
  }
  return retired;
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
const SYNC = z.object({ from: SHA, onto: SHA });
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

// Refuses a stop that conflicts on a gitlink before touching any entry: no
// writer or op chooses a submodule's revision. The error names each of its
// numbered stages.
function refuseGitlinkConflict(wt: string): void {
  const entries = conflictStages(wt);
  const link = entries.find((entry) => entry.mode === "160000");
  if (link === undefined) {
    return;
  }
  const evidence = entries
    .filter((entry) => entry.file === link.file)
    .map((entry) => `stage ${entry.stage}: ${entry.sha} (mode ${entry.mode})`)
    .join(", ");
  throw new OpsError(
    `unsupported gitlink conflict at ${JSON.stringify(link.file)}; ${evidence}; retaining unresolved checkout`,
  );
}

// Classify the actual checkout against its recorded synchronization, including
// a stop reached by a session's own continuation or one being rejected. A
// requested target must match while stopped; completed work has finish checks.
function classifyCodeSync(
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
  refuseGitlinkConflict(wt);
  return sync;
}

// Continue only once all text at a stop has been staged. Every subsequent
// stop is classified too.
function continueCodeSync(wt: string): void {
  while (rebaseInProgress(wt)) {
    refuseGitlinkConflict(wt);
    if (unmergedFiles(wt).length > 0) {
      return;
    }
    const result = run(
      "git",
      ["-C", wt, "-c", "core.editor=true", "rebase", "--continue"],
      { allowFail: true },
    );
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
  removeRetiredSubmodules,
  saveCodeSync,
  unmergedFiles,
};
