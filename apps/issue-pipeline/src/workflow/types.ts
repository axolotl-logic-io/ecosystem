// The shapes the workflow's helpers read and write. workflow.js is untyped, so
// these describe what it passes in: the issue's saved state, the work item the
// sweep holds for its issue, and the slices of the repo config each helper
// needs.

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
  pr?: number | null;
  // The PR branch's head as the pipeline last pushed or saw it.
  headSha?: string | null;
  implemented?: boolean;
  // The issue's event log, oldest first (event-log.ts).
  log?: string[];
  // Tokens the issue's sessions reported using.
  reportedTokens?: number;
  findings: Finding[];
  nextFindingId?: number;
  acceptReason?: string;
  // Tokens allocated to the issue's sessions so far.
  allocated: number;
  // The roles of the issue's latest sessions, oldest first.
  sessions?: string[];
}

// The local paths ops gives the issue at claim.
interface ItemPaths {
  worktree: string;
  issueFile: string;
  // The wiki checkout, or null when the repo's wiki is off.
  wiki: string | null;
}

// The issue the sweep works on.
interface WorkItem {
  n: number;
  st: IssueState;
  paths: ItemPaths;
  // Set when the acceptance verdict predates a clean rebase.
  rebasedOnly?: boolean;
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
