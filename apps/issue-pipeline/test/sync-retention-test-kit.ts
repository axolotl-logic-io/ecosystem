// Local-only conflicting rebases of the code checkout with independently
// staged and working resolver bytes.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../src/config.ts";
import type { Opened } from "./job-checkout-dropped-test-kit.ts";
import {
  COMMIT_ENV,
  close,
  openFresh,
} from "./job-checkout-dropped-test-kit.ts";
import { git, headOf, ISSUE, root, write } from "./pipeline-commit-test-kit.ts";

const { paths, withCheckout }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { syncOps }: typeof import("../src/ops/sync.ts") = await import(
  "../src/ops/sync.ts"
);

// `pushed` publishes the conflicting issue commit, so a retry conflicts again.
function conflicted(pushed = false): {
  job: Opened;
  dir: string;
  origin: string;
  file: string;
  remote: string;
  original: string;
  scoped: Config;
} {
  const job = openFresh();
  const dir = job.repo;
  const { origin } = job;
  const file = "README.md";
  const base = job.cfg.baseBranch;
  const start = headOf(dir);
  git(origin, ["fetch", dir, `HEAD:refs/heads/${job.branch}`]);
  write(dir, file, "original private commit\n");
  git(dir, ["commit", "-am", "Private original"], COMMIT_ENV);
  const original = headOf(dir);
  let remote = start;
  if (pushed) {
    git(origin, ["fetch", dir, `HEAD:refs/heads/${job.branch}`]);
    remote = original;
  }
  git(dir, ["checkout", "--detach", start]);
  write(dir, file, "new base commit\n");
  git(dir, ["commit", "-am", "Changed base"], COMMIT_ENV);
  git(origin, ["fetch", dir, `HEAD:refs/heads/${base}`]);
  git(dir, ["checkout", job.branch]);
  git(dir, ["fetch", "origin"]);
  try {
    git(dir, ["rebase", `origin/${base}`]);
  } catch {
    /* Expected content conflict. */
  }
  const clone = paths.clone(job.cfg);
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  git(root, ["clone", "--quiet", job.origin, clone]);
  const scoped = withCheckout(job.cfg, {
    issue: ISSUE,
    dir: job.repo,
    branch: job.branch,
  });
  return { job, dir, origin, file, remote, original, scoped };
}

function leaveResolution(w: ReturnType<typeof conflicted>): void {
  write(w.dir, w.file, "unique staged resolution\n");
  git(w.dir, ["add", w.file]);
  write(w.dir, w.file, "unique working resolution\n");
  write(w.dir, "resolver-notes.txt", "untracked resolution notes\n");
}

// What a sync op replies.
type SyncOpReply = ReturnType<NonNullable<(typeof syncOps)[string]>>;

function finish(w: ReturnType<typeof conflicted>, abort: boolean): SyncOpReply {
  const op = syncOps["finish-sync"];
  if (op === undefined) {
    throw new Error("missing finish-sync");
  }
  return op(w.scoped, { number: ISSUE, abort });
}

async function recovered(
  w: ReturnType<typeof conflicted>,
): Promise<{ folder: string; repo: string }> {
  await close(w.job, "resolver-exit");
  return recoveryOf(w);
}

// Restore the one snapshot with the requested evidence, not the first random
// directory: a rejected resolution and an unmerged retry have different kinds.
function recoveryOf(
  w: ReturnType<typeof conflicted>,
  evidence: "working.patch" | "conflict-stages.json" = "working.patch",
): { folder: string; repo: string } {
  const recovery = path.join(paths.runDir(w.job.cfg, ISSUE), "recovery");
  const entries = fs
    .readdirSync(recovery)
    .filter(
      (name) =>
        name.startsWith("sync-") &&
        fs.existsSync(path.join(recovery, name, "commits.bundle")) &&
        fs.existsSync(path.join(recovery, name, evidence)),
    );
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    throw new Error(
      `expected one ${evidence} snapshot, found ${entries.length}`,
    );
  }
  const folder = path.join(recovery, entry);
  const repo = fs.mkdtempSync(path.join(root, "resolver-restored-"));
  const bundle = path.join(folder, "commits.bundle");
  git(root, ["clone", bundle, repo]);
  git(repo, ["bundle", "verify", bundle]);
  return { folder, repo };
}

// Finishes the Git rebase before adding work that the finish check rejects.
function completeRebase(w: ReturnType<typeof conflicted>): void {
  write(w.dir, w.file, "rebased resolution commit\n");
  git(w.dir, ["add", w.file]);
  git(w.dir, ["-c", "core.editor=true", "rebase", "--continue"]);
}

export {
  completeRebase,
  conflicted,
  finish,
  leaveResolution,
  recovered,
  recoveryOf,
};
