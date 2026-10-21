import { assignedBranch } from "../branch-binding.ts";
import { leaseLane, liveClaims } from "../claims.ts";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { git } from "../github.ts";
import { authorizedIssue, trustedInputsHash } from "../issue-context.ts";
import { OpsError } from "../ops-error.ts";
import { readWriteState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { mergeAuthorization, sameRevision } from "../state.ts";
import { COMMAND_MS, localGit } from "./records.ts";
import type { Preparation } from "./schema.ts";
import { OID } from "./schema.ts";

const GIT_SUFFIX = /\.git$/u;
function configuredWikiRemote(cfg: Config): string {
  const code = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  return `${code.replace(GIT_SUFFIX, "")}.wiki.git`;
}
function assertRemote(cfg: Config, dir: string): string {
  const remote = configuredWikiRemote(cfg);
  if (
    localGit(dir, ["remote", "get-url", "--all", "origin"]) !== remote ||
    localGit(dir, ["remote", "get-url", "--push", "--all", "origin"]) !== remote
  ) {
    throw new OpsError(
      "wiki recovery remote is not the configured repository's wiki",
    );
  }
  return remote;
}
function freshAuthority(cfg: Config, issue: number, lane: string): IssueState {
  const state = readWriteState(cfg, issue);
  assignedBranch(cfg, issue, state);
  const comments = listComments(cfg, issue);
  const inputs = trustedInputsHash(cfg, authorizedIssue(cfg, issue), comments);
  const authorization = mergeAuthorization(state);
  if (
    authorization === null ||
    state.hardened === null ||
    state.hardened.inputs !== inputs ||
    authorization.inputs !== inputs ||
    state.gherkin?.inputs !== inputs ||
    state.security?.finding ||
    (state.stage !== "merge" &&
      !(state.stage === "stopped" && state.stoppedStage === "merge")) ||
    (state.lease !== null && leaseLane(state.lease) !== lane) ||
    liveClaims(cfg, comments).some((claim) => claim.lane !== lane)
  ) {
    throw new OpsError(
      "original wiki sync authority, inputs or claim cannot be verified; explicit operator reconciliation required",
    );
  }
  return state;
}
function sameAuthority(
  a: IssueState,
  b: IssueState,
  next: string | undefined,
): boolean {
  const original = mergeAuthorization(a);
  const current = mergeAuthorization(b);
  return (
    original !== null &&
    current !== null &&
    a.hardened !== null &&
    b.hardened !== null &&
    sameRevision(a.hardened, b.hardened) &&
    (sameRevision(original, current) ||
      (next !== undefined &&
        b.integration !== null &&
        sameRevision(b.integration.reviewed, a.hardened) &&
        b.integration.revision.wiki === next)) &&
    a.pr === b.pr &&
    JSON.stringify(a.gherkin) === JSON.stringify(b.gherkin)
  );
}
function validatePreparation(
  cfg: Config,
  issue: number,
  prep: Preparation,
  { lane, next }: { lane: string; next?: string },
): void {
  if (
    prep.authority.number !== issue ||
    prep.authority.branch !== prep.branch ||
    mergeAuthorization(prep.authority)?.wiki !== prep.old ||
    (prep.expected !== null && prep.expected !== prep.old) ||
    prep.repo !== cfg.repo ||
    prep.remote !== configuredWikiRemote(cfg) ||
    prep.issue !== issue ||
    prep.branch !== paths.branch(cfg, issue) ||
    prep.lane !== lane ||
    prep.base !== cfg.baseBranch ||
    prep.wikiBranch !== wikiCfg(cfg)?.branch ||
    !sameAuthority(prep.authority, freshAuthority(cfg, issue, lane), next)
  ) {
    throw new OpsError(
      "wiki sync checkpoint identity or original authority differs; both histories retained",
    );
  }
}
function exactRemoteTip(
  cfg: Config,
  dir: string,
  branch: string,
): string | null {
  assertRemote(cfg, dir);
  const ref = `refs/heads/${branch}`;
  const output = git(
    cfg,
    "merge",
    ["-C", dir, "ls-remote", "--refs", "origin", ref],
    { timeoutMs: COMMAND_MS },
  ).stdout.trim();
  if (output === "") {
    return null;
  }
  const [line, ...extra] = output.split("\n");
  const [sha, name] = (line ?? "").split("\t");
  if (extra.length > 0 || name !== ref) {
    throw new OpsError("ambiguous exact wiki remote ref");
  }
  return OID.parse(sha);
}

export {
  assertRemote,
  configuredWikiRemote,
  exactRemoteTip,
  freshAuthority,
  validatePreparation,
};
