// The shapes the workflow's modules read and write: the issue's saved state,
// the work item a helper reads for its issue, and the slices of the repo
// config each helper needs.

import type { Flows } from "./flows.ts";
import type { Signature } from "./signing.ts";

// A finding is open until a re-review resolves it.
type FindingStatus = "open" | "resolved";

// A blocking finding the pipeline tracks across fix rounds, numbered f1, f2, …
interface Finding {
  id: string;
  file: string;
  line: number;
  title: string;
  evidence: string;
  suggestion: string;
  lenses: string[];
  // The security harm category, or null for a finding from another lens.
  category: string | null;
  status: FindingStatus;
  disputed: boolean;
  // The fixer's evidence against the finding, once it disputes it.
  dispute?: string;
}

// A finding as a reviewer reports it, before the pipeline numbers it.
interface ReportedFinding {
  file: string;
  line: number;
  title: string;
  evidence: string;
  suggestion: string;
  category?: string | null;
}

// A finding as a review comment lists it: as reported, or numbered.
interface ListedFinding {
  id?: string;
  file: string;
  line: number;
  title: string;
  evidence: string;
  suggestion: string;
}

// The part of an issue's saved state (its hidden state comment) the helpers
// and the ported stages use.
interface IssueState {
  // The stage the issue is at, such as "triage" or "spec".
  stage: string;
  // 0 for an issue, 1 for a sub-issue of a split.
  depth: number;
  // How many times triage has run on the issue.
  triages?: number;
  // Triage's plan for the spec writer.
  plan?: string | null;
  // Triage's reason for judging the issue too big for one session, for the
  // spec writer.
  splitSuggested?: string | null;
  // The spec the implementer builds to, clipped to the spec stage's limit.
  spec?: string | null;
  // Where the full spec is (spec.md in the run dir), set only when `spec` was
  // clipped (#280).
  specFile?: string | null;
  // The repo paths or globs the spec says the change will touch.
  files?: string[] | null;
  // How many continuation sessions each writer stage has had. Read only
  // through stages/continuation.ts: a number is the older form, the
  // implementer's count.
  continuations?: Continuations | number;
  // The PR the implementer described, and its signature.
  prTitle?: string;
  prBody?: string;
  prBy?: Signature;
  pr?: number | null;
  // What the issue's work changes (flows.ts), as the last push or rebase
  // reported; missing until then, and after a restart.
  flows?: Flows;
  // Set while the issue's PR is closed because its change lives only in the
  // wiki.
  prClosed?: boolean;
  // The PR branch's head as the pipeline last pushed or saw it.
  headSha?: string | null;
  implemented?: boolean;
  // The head that last passed local verification, and its checks' results.
  verifiedSha?: string | null;
  verifySummary?: string;
  // Set when a clean rebase leaves a head that passed every check, so only
  // the tests run again.
  testsOnly?: boolean;
  // The head that passed every check, acceptance and the security review.
  passedSha?: string | null;
  // How many times the issue was rebased, its conflicts resolved, and its
  // failing checks fixed.
  syncs?: number;
  conflictFixes?: number;
  ciFixes?: number;
  // The issue's event log, oldest first (event-log.ts).
  log?: string[];
  // Tokens the issue's sessions reported using.
  reportedTokens?: number;
  findings: Finding[];
  nextFindingId?: number;
  acceptReason?: string;
  // The fix rounds run since the first review.
  round?: number;
  // The head the last review or re-review saw.
  reviewedSha?: string | null;
  // The findings resolved so far, as "<id>: <title>", the last 30.
  resolvedHistory?: string[];
  // The security reviews run on the issue.
  securityRounds?: number;
  // Tokens allocated to the issue's sessions so far.
  allocated: number;
  // Tokens allocated to the rebase pool (`rebaseTokenBudget`): conflict
  // resolvers, and re-checks after a rebase the merge stage asked for. Reset at
  // merge and restart; missing in states saved before #201, read as 0.
  rebaseAllocated?: number;
  // Whether the issue is re-checking after a rebase the merge stage asked for,
  // so its sessions are charged to the rebase pool. Missing reads as false.
  rechecking?: boolean;
  // The roles of the issue's latest sessions, oldest first.
  sessions?: string[];
}

// The local paths ops gives the issue at claim.
interface ItemPaths {
  worktree: string;
  issueFile: string;
  // The wiki checkout, or null when the repo's wiki is off.
  wiki: string | null;
  // Where an implementer that runs out of room writes its handoff.
  handoffFile: string;
}

// The issue the sweep works on.
interface WorkItem {
  n: number;
  st: IssueState;
  paths: ItemPaths;
  // Set when the acceptance verdict predates a clean rebase.
  rebasedOnly?: boolean;
}

// The continuation sessions each writer stage has had, missing meaning none.
interface Continuations {
  implement?: number;
  fix?: number;
  ciFix?: number;
  conflicts?: number;
}

// The slices of the repo config the helpers read.
interface RepoConfig {
  repo: string;
  baseBranch: string;
}

interface PracticesConfig {
  // The coding-practice files, relative to the worktree.
  practices?: readonly string[];
}

interface FixRoundsConfig {
  maxFixRounds: number;
}

// The roles a session is charged to, each with its own token budget.
type Role =
  | "triage"
  | "spec"
  | "implementer"
  | "reviewer"
  | "aggregator"
  | "fixer"
  | "rereviewer"
  | "ciFixer"
  | "verifier";

// What a role does with the coding practices: writes a spec to them, writes
// code to them, or reviews against them.
type PracticesUse = "spec" | "writer" | "reviewer";

export type {
  Continuations,
  Finding,
  FindingStatus,
  FixRoundsConfig,
  IssueState,
  ItemPaths,
  ListedFinding,
  PracticesConfig,
  PracticesUse,
  RepoConfig,
  ReportedFinding,
  Role,
  WorkItem,
};
