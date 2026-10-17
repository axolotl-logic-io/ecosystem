// The spec writer's checks that run git and the configured commands in the
// job's checkout (checks.ts names them for the machine): the start heads and
// what the stage committed since them, the commit check at the spec head, the
// no-work test run, the removal of the spec draft and the handoff once the
// spec is posted, and the reset of the issue's code and wiki branches to the
// heads the stage began from.
// `cfg` is the job's config with its checkout, so the worktree and wiki paths
// are the job's.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../../config.ts";
import { paths, wikiCfg } from "../../config.ts";
import { head } from "../../git-state.ts";
import { git } from "../../github.ts";
import { matchAny } from "../../globs.ts";
import { withWikiLock } from "../../locks.ts";
import { OpsError, run, shell } from "../../process.ts";
import { readWikiChange } from "../../wiki-check.ts";
import type { CheckedInterface, SpecTestsResult } from "./check.ts";
import { specTestsCheck } from "./check.ts";
import type { SpecCommitted } from "./task.ts";
import { SPEC_DRAFT, SPEC_TRAILER } from "./task.ts";

const MS_PER_MINUTE = 60_000;
const SHORT_SHA_LENGTH = 8;
const WHITESPACE = /\s/u;

const COMMAND = z.string().nullish();
const SETTINGS = z.looseObject({
  commands: z.looseObject({
    lint: COMMAND,
    setup: COMMAND,
    test: z.string(),
    typecheck: COMMAND,
  }),
  commandTimeoutMinutes: z.number(),
  testPathGlobs: z.array(z.string()),
});

// The job's config with its checkout, the issue, the issue it is stacked on,
// if any, and the handoff file a session that ran out of room writes.
interface SpecJob {
  cfg: Config;
  n: number;
  stackedOn: number | null;
  handoffFile: string;
}

// The heads the spec stage began from, or null where the branch is new.
interface StartHeads {
  startSha: string | null;
  startWikiSha: string | null;
}

// What the spec writer committed, as the commit check reads it.
interface SpecCommits {
  startSha: string | null;
  files: readonly string[];
  interfaces: readonly CheckedInterface[];
  noTestsReason: string | null;
}

// A command's outcome: whether it passed, and its output when it didn't.
type Judged = { pass: true } | { pass: false; output: string };

function refHead(dir: string, ref: string): string | null {
  const args = ["-C", dir, "rev-parse", "--verify", "--quiet", ref];
  const result = run("git", args, { allowFail: true });
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

// The wiki checkout's folder, when the repo has a wiki and the job holds it.
function wikiDir(cfg: Config, n: number): string | null {
  const dir = paths.wiki(cfg, n);
  if (wikiCfg(cfg) === null || !fs.existsSync(path.join(dir, ".git"))) {
    return null;
  }
  return dir;
}

// The heads of the issue's branch on the remotes, as the job's checkouts
// last fetched them.
function startHeads(cfg: Config, n: number): StartHeads {
  const ref = `refs/remotes/origin/${paths.branch(n)}`;
  const dir = wikiDir(cfg, n);
  let startWikiSha: string | null = null;
  if (dir !== null) {
    startWikiSha = refHead(dir, ref);
  }
  return { startSha: refHead(paths.worktree(cfg, n), ref), startWikiSha };
}

// What the spec writer's commits start from: the branch's start head, or for
// a new branch the head of the branch it is stacked on, or the base.
function baseOf(job: SpecJob, startSha: string | null): string {
  const { cfg, n, stackedOn } = job;
  if (startSha !== null) {
    return startSha;
  }
  const wt = paths.worktree(cfg, n);
  if (stackedOn !== null) {
    const stacked = `origin/${paths.branch(stackedOn)}`;
    if (refHead(wt, stacked) !== null) {
      return stacked;
    }
  }
  return `origin/${cfg.baseBranch}`;
}

// Whether `file` exists in the checkout `wt` at HEAD.
function atHead(wt: string, file: string): boolean {
  const args = ["-C", wt, "cat-file", "-e", `HEAD:${file}`];
  return run("git", args, { allowFail: true }).code === 0;
}

// What the stage committed since `heads`: the code branch's test files and
// other files (stubs), whether the spec draft is at its head, and the wiki
// pages the issue's wiki branch changed.
function committedSince(job: SpecJob, heads: StartHeads): SpecCommitted {
  const { cfg, n } = job;
  const { testPathGlobs } = SETTINGS.parse(cfg);
  const wt = paths.worktree(cfg, n);
  const range = `${baseOf(job, heads.startSha)}...HEAD`;
  const changed = run("git", ["-C", wt, "diff", "--name-only", range])
    .stdout.split("\n")
    .filter((file) => file !== "" && file !== SPEC_DRAFT);
  function isTest(file: string): boolean {
    return matchAny(testPathGlobs, file);
  }
  return {
    tests: changed.filter(isTest),
    stubs: changed.filter((file) => !isTest(file)),
    wiki: readWikiChange(cfg, n)?.changed ?? [],
    draft: atHead(wt, SPEC_DRAFT),
  };
}

// What the stage leaves once its spec is posted, removed: the spec draft,
// from the issue's branch in one pushed commit so it never merges, and the
// handoff file, which the implementer would take for its own.
function dropLeftovers(job: SpecJob): void {
  const { cfg, n } = job;
  const wt = paths.worktree(cfg, n);
  fs.rmSync(job.handoffFile, { force: true });
  if (!atHead(wt, SPEC_DRAFT)) {
    return;
  }
  run("git", ["-C", wt, "rm", "--quiet", "--", SPEC_DRAFT]);
  const message = `Remove the spec draft of #${n}, now that the spec is posted\n\nPipeline-Agent: spec writer`;
  // A job checkout's pre-commit hook passes only commits that say so.
  const env = new Map([["ISSUE_PIPELINE_COMMIT", "1"]]);
  run("git", ["-C", wt, "commit", "--quiet", "-m", message], { env });
  const ref = `HEAD:refs/heads/${paths.branch(n)}`;
  git(cfg, ["-C", wt, "push", "--quiet", "origin", ref]);
}

// Runs the commit check (check.ts) at the job checkout's head.
function specTestsAtHead(
  job: SpecJob,
  commits: SpecCommits,
): SpecTestsResult & { sha: string } {
  const { cfg, n } = job;
  const settings = SETTINGS.parse(cfg);
  const wt = paths.worktree(cfg, n);
  const sha = head(wt);
  const short = sha.slice(0, SHORT_SHA_LENGTH);
  const result = specTestsCheck(
    {
      cfg,
      number: n,
      wt,
      base: baseOf(job, commits.startSha),
      sha,
      logDir: path.join(paths.runDir(cfg, n), `spec-tests-${short}`),
      timeoutMs: settings.commandTimeoutMinutes * MS_PER_MINUTE,
      files: commits.files,
      interfaces: commits.interfaces,
      noTestsReason: commits.noTestsReason,
      wiki: readWikiChange(cfg, n),
    },
    settings,
  );
  return { ...result, sha };
}

// Whether there is no work: the branch changes nothing since it began, or
// the test command passes at its head (the base plus the spec's tests).
function noWorkConfirmed(job: SpecJob, startSha: string | null): Judged {
  const { cfg, n } = job;
  const wt = paths.worktree(cfg, n);
  const base = baseOf(job, startSha);
  const diff = ["-C", wt, "diff", "--quiet", base, "HEAD"];
  if (run("git", diff, { allowFail: true }).code === 0) {
    return { pass: true };
  }
  const settings = SETTINGS.parse(cfg);
  const log = path.join(paths.runDir(cfg, n), "no-work-test.log");
  const timeout = settings.commandTimeoutMinutes * MS_PER_MINUTE;
  const result = shell(settings.commands.test, wt, log, timeout);
  if (result.code === 0) {
    return { pass: true };
  }
  return { pass: false, output: result.tail };
}

// Throws unless the remote head `seen` of the issue's branch holds only work
// the reset may discard: it is the head `dir` last fetched or pushed, so no
// one pushed since, and every commit it adds to `base` is the spec writer's,
// by its trailer line, so none is a person's.
function assertOwnHead(
  dir: string,
  branch: string,
  heads: { seen: string; base: string },
): void {
  const { seen, base } = heads;
  const known = refHead(dir, `refs/remotes/origin/${branch}`);
  if (known !== seen) {
    const why = `${branch} moved to ${seen} on the remote since the job read it at ${known ?? "no head"}`;
    throw new OpsError(`the reset leaves ${branch} as it is: ${why}`);
  }
  const others = run("git", [
    ...["-C", dir, "rev-list", "--count", "--invert-grep"],
    `--grep=^${SPEC_TRAILER}$`,
    ...[seen, "--not", base],
  ]).stdout.trim();
  if (others !== "0") {
    const why = `${others} of its commits since ${base} are not the spec writer's`;
    throw new OpsError(`the reset leaves ${branch} as it is: ${why}`);
  }
}

// Moves the issue's branch on `dir`'s remote to `target`, or deletes it for
// null, with a lease on the head the job last knew, and only when it holds no
// one else's work (assertOwnHead); a remote already there is left alone. Then
// resets the checkout to `target`, or to `fallback`.
function resetBranch(
  cfg: Config,
  where: { dir: string; n: number; fallback: string },
  target: string | null,
): void {
  const { dir, n, fallback } = where;
  const branch = paths.branch(n);
  const ref = `refs/heads/${branch}`;
  const listed = git(cfg, ["-C", dir, "ls-remote", "origin", ref]).stdout;
  const seen = listed.trim().split(WHITESPACE)[0] ?? "";
  if (seen !== (target ?? "")) {
    if (seen !== "") {
      assertOwnHead(dir, branch, { seen, base: target ?? fallback });
    }
    let to = `:${ref}`;
    if (target !== null) {
      to = `${target}:${ref}`;
    }
    const lease = `--force-with-lease=${ref}:${seen}`;
    git(cfg, ["-C", dir, "push", lease, "origin", to]);
  }
  run("git", ["-C", dir, "reset", "--quiet", "--hard", target ?? fallback]);
}

// Resets the issue's code branch to `heads.startSha` and its wiki branch to
// `heads.startWikiSha`, deleting a branch the stage created (null), and
// deletes the stage's handoff file.
function resetBranches(job: SpecJob, heads: StartHeads): void {
  const { cfg, n } = job;
  fs.rmSync(job.handoffFile, { force: true });
  const wt = paths.worktree(cfg, n);
  const fallback = baseOf(job, null);
  resetBranch(cfg, { dir: wt, n, fallback }, heads.startSha);
  const dir = wikiDir(cfg, n);
  const wiki = wikiCfg(cfg);
  if (dir === null || wiki === null) {
    return;
  }
  const wikiBase = { dir, n, fallback: `origin/${wiki.branch}` };
  withWikiLock(cfg, () => resetBranch(cfg, wikiBase, heads.startWikiSha));
}

export type { Judged, SpecCommits, SpecJob, StartHeads };
export {
  committedSince,
  dropLeftovers,
  noWorkConfirmed,
  resetBranches,
  specTestsAtHead,
  startHeads,
};
