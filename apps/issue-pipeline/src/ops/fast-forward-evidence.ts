// Fast-forward provenance requires authenticated saved intent. Neither a PR
// head nor an equal target alone can manufacture an original delivery range.
import { assignedBranch } from "../branch-binding.ts";
import type { Config } from "../config.ts";
import { git } from "../github.ts";
import { FULL_SHA } from "../land-provenance.ts";
import { OpsError } from "../ops-error.ts";
import type { CodeLanded, IssueState } from "../state.ts";
import { sameRevision } from "../state.ts";
import { assertFastForward, targetRef } from "./land-branch.ts";
import { confirmAuthorization } from "./landing-attempt.ts";

const WHITESPACE = /\s+/u;

function intendedBase(
  cfg: Config,
  number: number,
  state: IssueState,
  result: CodeLanded,
): string | undefined {
  const attempt = state.landingAttempt;
  if (attempt?.operation === undefined) {
    return undefined;
  }
  if (
    attempt.repo !== cfg.repo ||
    attempt.target !== cfg.baseBranch ||
    attempt.branch !== assignedBranch(cfg, number, state) ||
    attempt.pr !== state.pr ||
    attempt.pr !== result.pr ||
    attempt.authorized.code !== result.sha ||
    (attempt.result !== null && attempt.result !== result.sha)
  ) {
    throw new OpsError(
      "fast-forward receipt differs from its bound intended operation",
    );
  }
  return attempt.operation.base;
}

// A freshly authenticated saved receipt may outlive a lost push response.
// This preserves confirmed evidence only; equal heads cannot create a receipt.
function retainedFastForwardReceipt(
  cfg: Config,
  number: number,
  state: IssueState,
): boolean {
  const attempt = state.landingAttempt;
  if (attempt?.operation === undefined || state.landed === null) {
    return false;
  }
  if (
    state.codeLanded === null ||
    intendedBase(cfg, number, state, state.codeLanded) === undefined ||
    !sameRevision(state.landed, attempt.authorized)
  ) {
    throw new OpsError(
      "saved fast-forward receipt differs from its exact intent",
    );
  }
  confirmAuthorization(state, attempt);
  return true;
}

function confirmedFastForwardBase(
  cfg: Config,
  number: number,
  wt: string,
  { state, result }: { state: IssueState; result: CodeLanded },
): string | undefined {
  const base = intendedBase(cfg, number, state, result);
  if (base === undefined) {
    return undefined;
  }
  const attempt = state.landingAttempt;
  if (
    attempt === null ||
    state.landed === null ||
    !sameRevision(state.landed, attempt.authorized) ||
    state.codeLanded?.pr !== result.pr ||
    state.codeLanded.sha !== result.sha
  ) {
    throw new OpsError(
      "fast-forward has no authenticated confirmed delivery receipt",
    );
  }
  assertFastForward(wt, base, result.sha);
  return base;
}

// Read the exact literal target, not an abbreviated or glob-selected ref.
function exactTarget(cfg: Config, wt: string): string {
  const ref = targetRef(cfg);
  const result = git(cfg, "landing", ["-C", wt, "ls-remote", "origin", ref]);
  const [sha, found, extra] = result.stdout.trim().split(WHITESPACE);
  if (found !== ref || extra !== undefined) {
    throw new OpsError("configured target has no unique exact remote head");
  }
  return FULL_SHA.parse(sha);
}

export {
  confirmedFastForwardBase,
  exactTarget,
  intendedBase,
  retainedFastForwardReceipt,
};
