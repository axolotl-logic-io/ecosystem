// The shapes the workflow's modules read and write: the issue's saved state,
// the work item a helper reads for its issue, the slices of the repo config
// each helper needs, and the sweep its driver (sweep.ts) gives its caller.

import type { Flows } from "./flows.ts";
import type { LaunchSpec } from "./launches.ts";
import type { Signature } from "./signing.ts";
import type { SweepSummary } from "./stages/types.ts";

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
  // Whether the spec writer wrote the tests and stubs the spec documents, so
  // a restart that finds one missing stops (src/restart-spec.ts). The spec
  // stage sets it false; the spec writer that writes them (#305) sets it true.
  specWritesTests?: boolean;
  // The test and stub files the spec documents that the branch lacked at the
  // last restart, when the spec writer didn't write them: work the
  // implementer finishes.
  unwrittenFiles?: string[];
  // The prerequisite issue this one's branch is stacked on, and the head of
  // its branch the branch was last put on (#268); null when it isn't.
  stackedOn?: { issue: number; headSha: string } | null;
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
  // Tokens the issue's sessions reported spending, less cache reads
  // (rateTokens); an issue saved before 2026-10-16 counted them too.
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
  // The head the security review last passed, and that head's tree (null
  // when its diff named none); a later head with the same tree skips the
  // review (security-skip-unchanged).
  securitySha?: string | null;
  securityTree?: string | null;
  // A state saved before budgets-bound-context (2026-10-16) also holds
  // `allocated`, `rebaseAllocated`, `rechecking` and `sessions`, the spend
  // bookkeeping of the removed issue budget and rebase allowance. Nothing
  // reads them, and they pass through unchanged.
}

// A stage job's folder, where its sessions run beside its code and wiki
// checkouts, and its stage's access to the wiki checkout (#338).
interface JobLayout {
  dir: string;
  docs: "read" | "write";
}

// The local paths ops gives the issue at claim.
interface ItemPaths {
  worktree: string;
  issueFile: string;
  // The wiki checkout, or null when the repo's wiki is off.
  wiki: string | null;
  // Where an implementer that runs out of room writes its handoff.
  handoffFile: string;
  // The stage job's folder, in a stage job only; a lane has none.
  job?: JobLayout;
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

// The roles a session runs as, each with its own context budget.
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

// The sweep's id and its clock.
interface SweepClock {
  sweepId: string;
  now: () => Date;
}

interface Sweep {
  next: (raw: readonly unknown[]) => LaunchSpec[];
  summary: () => SweepSummary;
  // The save that leaves the claimed open issue at its stage with no lease
  // when a stop cuts the stages short; null outside the stages.
  interrupt: () => LaunchSpec | null;
  // The claimed issue's state as it stands, or null before a claim and when
  // none was claimed.
  claimed: () => IssueState | null;
}

export type {
  Continuations,
  Finding,
  FindingStatus,
  FixRoundsConfig,
  IssueState,
  ItemPaths,
  JobLayout,
  ListedFinding,
  PracticesConfig,
  PracticesUse,
  RepoConfig,
  ReportedFinding,
  Role,
  Sweep,
  SweepClock,
  WorkItem,
};
