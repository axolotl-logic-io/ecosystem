// The verify op: runs a PR's checks and reports each one. The checks are the
// configured commands (setup first, which stops verify when it fails),
// whether each changed lockfile regenerates to itself, and the migrations when
// the change touches them. Before the code merges they run in the issue's
// checkout, which verify leaves as it found it. Once it merged, they run at
// the exact merge commit GitHub reports, in a clean detached checkout of it
// that verify removes, so the issue's checkout and its pending wiki work stay
// as they are.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { updateSubmodules } from "../clone-setup.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { assertClean, fetchIn, gitIn, head } from "../git-state.ts";
import { OpsError, parseRequest, run, shell } from "../process.ts";
import { confirmMerged } from "../revision.ts";
import { holdWikiPin } from "../wiki.ts";
import type { VerifyReply } from "./checks.ts";
import { changedFiles, present, runChecks, SETTINGS } from "./checks.ts";

const TEARDOWN_TIMEOUT_MS = 300_000;

const REQUEST = z.looseObject({
  number: z.number().int().positive(),
  // The merged PR and its merge commit, once the code merged.
  codeMerged: z
    .object({ pr: z.number().int().positive(), sha: z.string().min(1) })
    .nullish(),
});

// Verifies the issue's checkout's HEAD, measuring its change from where it
// leaves the base branch.
function verifyCheckout(cfg: Config, n: number): VerifyReply {
  const wt = paths.worktree(cfg, n);
  // The finalizer's rebase (#422), or a writer's own reset, may have
  // replayed commits that move the wiki pin.
  holdWikiPin(cfg, wt);
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const sha = head(wt);
  const base = gitIn(wt, [
    "merge-base",
    `origin/${cfg.baseBranch}`,
    "HEAD",
  ]).trim();
  const changed = changedFiles(wt, base, sha);
  return runChecks(cfg, n, { dir: wt, sha, changed });
}

// Runs the configured teardown in the verify checkout `dir`, if it sets
// one, logging to `log`, then removes the checkout from `wt`'s repo.
function removeVerifyCheckout(
  wt: string,
  dir: string,
  teardown: { command: string | null | undefined; log: string },
): void {
  if (present(teardown.command) && fs.existsSync(dir)) {
    shell(teardown.command, dir, teardown.log, TEARDOWN_TIMEOUT_MS);
  }
  run("git", ["-C", wt, "worktree", "remove", "--force", dir], {
    allowFail: true,
  });
  run("git", ["-C", wt, "worktree", "prune"], { allowFail: true });
}

// Verifies merge commit `sha` of PR `pr`, once GitHub confirms the PR
// merged as `sha` and the fetched base branch holds it, in a clean detached
// checkout of it. Its change is what the merge brought onto the base.
function verifyMerged(
  cfg: Config,
  n: number,
  codeMerged: { pr: number; sha: string },
): VerifyReply {
  const { sha } = codeMerged;
  const wt = paths.worktree(cfg, n);
  confirmMerged(cfg, n, { wt, codeMerged });
  const runDir = paths.runDir(cfg, n);
  fs.mkdirSync(runDir, { recursive: true });
  const parent = fs.mkdtempSync(path.join(runDir, "verify-merged-"));
  const dir = path.join(parent, "repo");
  const teardown = {
    command: SETTINGS.parse(cfg).commands.teardown,
    log: path.join(runDir, "verify-merged-teardown.log"),
  };
  try {
    gitIn(wt, ["worktree", "add", "--detach", dir, sha]);
    updateSubmodules(cfg, dir);
    const at = head(dir);
    if (at !== sha) {
      throw new OpsError(`the verify checkout is at ${at}, not ${sha}`);
    }
    const changed = changedFiles(dir, `${sha}^1`, sha);
    return runChecks(cfg, n, { dir, sha, changed });
  } finally {
    removeVerifyCheckout(wt, dir, teardown);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function verify(cfg: Config, request: unknown): VerifyReply {
  const { number, codeMerged } = parseRequest(REQUEST, "verify", request);
  if (codeMerged === undefined || codeMerged === null) {
    return verifyCheckout(cfg, number);
  }
  return verifyMerged(cfg, number, codeMerged);
}

export { verify };
