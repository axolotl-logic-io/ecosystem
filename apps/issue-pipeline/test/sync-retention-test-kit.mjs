// @ts-check
// Local-only conflicting rebases with independently staged and working resolver bytes.
import fs from "node:fs";
import path from "node:path";
import {
  COMMIT_ENV,
  close,
  openFresh,
} from "./job-checkout-dropped-test-kit.mjs";
import {
  git,
  headOf,
  ISSUE,
  root,
  write,
} from "./pipeline-commit-test-kit.mjs";

const { paths, wikiCfg, withCheckout } = await import("../src/config.ts");
const { syncOps } = await import("../src/ops/sync.ts");
const { finishWikiSync } = await import("../src/wiki-publish.ts");

// `pushed` publishes the conflicting issue commit, so a retry conflicts again.
/** @param {"code" | "wiki"} side @param {boolean} [pushed] */
function conflicted(side, pushed = false) {
  const job = openFresh();
  let dir = job.repo;
  let { origin } = job;
  let file = "README.md";
  let base = job.cfg.baseBranch;
  if (side === "wiki") {
    dir = job.docs;
    origin = job.wikiOrigin;
    file = "Home.md";
    base = wikiCfg(job.cfg)?.branch ?? "main";
  }
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
  return { job, dir, origin, file, remote, original, scoped, side };
}

/** @param {ReturnType<typeof conflicted>} w */
function leaveResolution(w) {
  write(w.dir, w.file, "unique staged resolution\n");
  git(w.dir, ["add", w.file]);
  write(w.dir, w.file, "unique working resolution\n");
  write(w.dir, "resolver-notes.txt", "untracked resolution notes\n");
}

/** @param {ReturnType<typeof conflicted>} w @param {boolean} abort */
function finish(w, abort) {
  if (w.side === "wiki") {
    let reason = null;
    if (abort) {
      reason = "resolver failed";
    }
    return finishWikiSync(w.scoped, ISSUE, reason);
  }
  const op = syncOps["finish-sync"];
  if (op === undefined) {
    throw new Error("missing finish-sync");
  }
  return op(w.scoped, { number: ISSUE, abort });
}

/** @param {ReturnType<typeof conflicted>} w */
async function recovered(w) {
  await close(w.job, "resolver-exit");
  return recoveryOf(w);
}

/** @param {ReturnType<typeof conflicted>} w */
function recoveryOf(w) {
  const recovery = path.join(paths.runDir(w.job.cfg, ISSUE), "recovery");
  const entries = fs
    .readdirSync(recovery)
    .filter(
      (name) =>
        name.startsWith("sync-") &&
        fs.existsSync(path.join(recovery, name, "commits.bundle")),
    );
  const folder = path.join(recovery, entries[0] ?? "missing");
  const repo = fs.mkdtempSync(path.join(root, "resolver-restored-"));
  git(root, ["clone", path.join(folder, "commits.bundle"), repo]);
  return { folder, repo };
}

// Finishes the Git rebase before adding work that the finish check rejects.
/** @param {ReturnType<typeof conflicted>} w */
function completeRebase(w) {
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
