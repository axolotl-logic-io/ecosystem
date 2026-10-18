// The push ops: push pushes the issue's code branch and its wiki commits;
// exit-push is the push a writer's stage job makes as it exits. Once the
// saved state records the code merged, or when asked to, they push only the
// wiki, and only from a checkout at the issue's authoritative code head, so
// no local code commit is pushed or left behind unnoticed.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PushResult } from "../checkouts.ts";
import { branchChanges, push } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { assertClean, head, remoteHead } from "../git-state.ts";
import { OpsError, parseRequest } from "../process.ts";
import { pullRequest } from "../revision.ts";
import { readState } from "../saved-state.ts";
import type { CodeMerged } from "../state.ts";
import { holdWikiPin, pushWikiBranch, wikiAhead } from "../wiki.ts";

const PUSH_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  // Push only the wiki branch, never the code.
  wikiOnly: z.literal(true).nullish(),
});

type PushOp = (cfg: Config, request: unknown) => PushResult;

// Throws when issue `n`'s saved state records its code merged, since `op`
// would push code.
function refuseOnceMerged(cfg: Config, n: number, op: string): void {
  const codeMerged = readState(cfg, n).state?.codeMerged ?? null;
  if (codeMerged !== null) {
    throw new OpsError(
      `#${n}'s code merged in PR #${codeMerged.pr}, so ${op} can't push code; push the wiki with push {wikiOnly: true}`,
    );
  }
}

// The code head the checkout must be at for a wiki-only push: the issue
// branch's head on GitHub or, once the code merged and the branch was
// deleted, the merged PR's own head as GitHub keeps it. Throws when neither
// can be confirmed.
function authoritativeHead(
  cfg: Config,
  n: number,
  codeMerged: CodeMerged | null,
): string {
  const remote = remoteHead(cfg, n);
  if (remote !== null) {
    return remote;
  }
  if (codeMerged === null) {
    throw new OpsError(
      `${paths.branch(n)} isn't on GitHub, so the checkout's code head can't be confirmed`,
    );
  }
  const pr = pullRequest(cfg, n, codeMerged.pr);
  if (pr.state !== "MERGED" || pr.mergeCommit !== codeMerged.sha) {
    throw new OpsError(
      `GitHub doesn't report PR #${codeMerged.pr} merged as ${codeMerged.sha}`,
    );
  }
  return pr.headSha;
}

// Pushes only the issue's wiki commits, once its checkout's code head is
// the authoritative one (authoritativeHead), so no local code commit is
// pushed or left behind unnoticed. Once the code merged, no code changes.
function pushWikiOnly(
  cfg: Config,
  n: number,
  codeMerged: CodeMerged | null,
): PushResult {
  const wt = paths.worktree(cfg, n);
  holdWikiPin(cfg, wt);
  assertClean(wt, "worktree");
  const headSha = head(wt);
  const expected = authoritativeHead(cfg, n, codeMerged);
  if (headSha !== expected) {
    throw new OpsError(
      `the checkout's code head ${headSha} isn't ${expected}, the issue's code head on GitHub; a wiki-only push never pushes or drops code`,
    );
  }
  const wiki = paths.wiki(cfg, n);
  if (wikiCfg(cfg) !== null && fs.existsSync(path.join(wiki, ".git"))) {
    assertClean(wiki, "the wiki checkout");
  }
  pushWikiBranch(cfg, n);
  let codeChanged = false;
  if (codeMerged === null) {
    ({ codeChanged } = branchChanges(cfg, n));
  }
  return { headSha, codeChanged, wikiAhead: wikiAhead(cfg, n) };
}

// Pushes the issue's work for `op`: its code and wiki, or only its wiki
// when asked to or once the saved state records the code merged.
function pushFor(cfg: Config, request: unknown, op: string): PushResult {
  const { number, wikiOnly } = parseRequest(PUSH_REQUEST, op, request);
  const { state } = readState(cfg, number);
  const codeMerged = state?.codeMerged ?? null;
  if (wikiOnly === true || codeMerged !== null) {
    return pushWikiOnly(cfg, number, codeMerged);
  }
  return push(cfg, number, op);
}

function pushOp(cfg: Config, request: unknown): PushResult {
  return pushFor(cfg, request, "push");
}

// The push a writer's stage job makes as it exits, of commits its checkout
// holds past the last state save (src/job/exit-push.ts). It is recorded as
// "exit-push", which the next claim may adopt (adopt-push.ts).
function exitPushOp(cfg: Config, request: unknown): PushResult {
  return pushFor(cfg, request, "exit-push");
}

const pushOps: Readonly<Record<string, PushOp>> = {
  push: pushOp,
  "exit-push": exitPushOp,
};

export { pushOps, refuseOnceMerged };
