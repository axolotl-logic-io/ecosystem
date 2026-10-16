// The step machine the sweep runs its stages on. A stage is a sync `next`
// that takes the issue's JSON-safe state and the results of the launches it
// asked for last, and returns its next step: more launches, or done. The
// sweep's driver (../sweep.ts) applies the comments and the stop each step
// carries and hands its launches to the loop that awaits them, so no stage
// awaits anything. The sweep's entry (entry.ts) has its own steps here too.

import type { Budgets, LaunchBudget } from "../budget.ts";
import type { JsonSchema } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import type {
  FixRoundsConfig,
  IssueState,
  ItemPaths,
  PracticesConfig,
  RepoConfig,
  Role,
} from "../types.ts";

// The stages, in the order an issue moves through them.
type StageName =
  | "triage"
  | "spec"
  | "implement"
  | "open-pr"
  | "review"
  | "fix"
  | "sync"
  | "checks"
  | "accept"
  | "security"
  | "merge"
  | "publish";

// The issue as a stage sees it. `phase` is its own position, "begin" at first.
interface StageState {
  n: number;
  paths: ItemPaths;
  st: IssueState;
  closed: boolean;
  // Why the issue is closed for this sweep, such as "split", or null.
  outcome: string | null;
  // Set when the spawn cap holds the issue at its stage until next sweep.
  held: boolean;
  // Set when checks pass on a clean rebase of a head that passed acceptance
  // and the security review before it.
  rebasedOnly: boolean;
  // Set when merge sent the issue back to sync to rebase this sweep; unsaved.
  resynced: boolean;
  phase: string;
  // JSON-safe data the stage passes to its own next step within one sweep,
  // null at "begin" and never saved. Each stage reads it through its guard.
  carry: unknown;
}

// A model session. The sweep keys it "i<n>-<name>-<seq>" and signs its result
// with `role`, or `name` with no role. Its preamble shows `tokenBudget`.
interface ChildLaunch extends LaunchBudget {
  kind: "child";
  name: string;
  role?: string;
  label: string;
  agent: string;
  model: string;
  schema: JsonSchema;
  minutes: number;
  task: string;
  // A session that changes the code, which the sweep's own checks verify.
  writer?: true;
}

// An ops request, carrying the comments queued for the issue. The sweep keys
// it "i<n>-<name>-<seq>".
interface OpLaunch {
  kind: "op";
  name: string;
  op: string;
  payload: Readonly<Record<string, unknown>>;
  minutes?: number;
}

type Launch = ChildLaunch | OpLaunch;

// A finished session, signed with its launch's role.
interface ChildResult {
  kind: "child";
  ok: boolean;
  structuredOutput: unknown;
  error: string | null;
  by: Signature;
}

// An ops reply, `{ ok: false, error }` when the op or its child failed.
interface OpResult {
  kind: "op";
  reply: Readonly<Record<string, unknown>>;
}

// The results come in the order of the launches.
type LaunchResult = ChildResult | OpResult;

// A signed comment for the issue, or for its PR once it has one.
interface StageComment {
  by: Signature;
  body: string;
  where: "issue" | "pr";
}

// Stops work on the issue, with the reason, an optional detail and the stop
// code that names its label, or null for the generic one.
interface StageStop {
  reason: string;
  detail: string | null;
  code: string | null;
}

interface StepEffects {
  state: StageState;
  comments: readonly StageComment[];
  stop: StageStop | null;
}

interface LaunchStep extends StepEffects {
  done: false;
  launches: readonly [Launch, ...Launch[]];
}

interface DoneStep extends StepEffects {
  done: true;
  // This round of the stage is finished, and the sweep begins the stage again
  // if the issue is still at it and it fits under the spawn cap.
  again: boolean;
}

// What the sweep does next: apply the effects, then launch or move on.
type Step = LaunchStep | DoneStep;

// The roles that have a model setting.
type ModelRole =
  | "triage"
  | "spec"
  | "implementer"
  | "correctness"
  | "tests"
  | "scope"
  | "aggregator"
  | "fixer"
  | "verifier"
  | "security"
  | "acceptance";

// The commands the implementer runs before it finishes, each only if set.
interface StageCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
}

interface StageConfig extends RepoConfig, PracticesConfig, FixRoundsConfig {
  maxTriages: number;
  maxSyncs: number;
  maxCiFixes: number;
  maxContinuations: number;
  ciWaitMinutes: number;
  // Missing or null means 2.
  maxConflictFixes?: number | null;
  commands: StageCommands;
}

// What every stage reads besides the issue: the repo config, the token
// budgets, the models, the clock, whether the spawn cap leaves room for a
// stage, and the orchestrator's merge order, or null outside it (#234).
interface StageContext {
  cfg: StageConfig;
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
  now: () => Date;
  hasRoom: (stage: StageName) => boolean;
  mergeQueue: readonly number[] | null;
}

// The repo config as the sweep reply carries it: what the stages read, the
// token budgets, and the config's overrides of the sweep's defaults.
interface SweepConfig extends StageConfig {
  sessionTokenCap: number;
  contextLimits: { soft: number; hard: number };
  issueTokenBudget: number;
  rebaseTokenBudget: number;
  roleBudgets?: Readonly<Partial<Record<Role, number>>> | null;
  models?: Readonly<Partial<Record<ModelRole, string>>> | null;
  maxSpawnsPerRun?: number | null;
}

// An issue the sweep may claim.
interface SweepCandidate {
  number: number;
}

// The sweep op's reply: the config, the candidates in the order to claim
// them, how many issues wait for an answer, the parents to close, and the
// named issue it left alone for its stop label, if any.
interface SweepReply {
  ok: true;
  config: SweepConfig;
  items: readonly SweepCandidate[];
  waiting: number;
  parents: readonly number[];
  stopped?: { issue: number; label: string };
}

// A candidate another lane claimed first: the lane that holds it, and
// whether ops noted on the issue that this lane abandoned it.
interface AbandonedClaim {
  issue: number;
  holder: string | null;
  commented: boolean;
}

// Why a candidate the sweep didn't lose is still not its to work on: the
// claim failed, or the issue waits for an answer to the pipeline's questions.
type UnclaimedOutcome = "claim-failed" | "waiting-for-answer";

// What a claim reply means for the sweep: the candidate was lost to another
// lane, it stays unclaimed (with its outcome and reason, if any), or the
// sweep holds the issue, with the stop to queue if its PR branch moved.
type ClaimStep =
  | { kind: "lost"; abandoned: AbandonedClaim }
  | { kind: "unclaimed"; outcome: UnclaimedOutcome; reason: string | null }
  | {
      kind: "claimed";
      st: IssueState;
      paths: ItemPaths;
      stop: StageStop | null;
    };

// The sweep's issue in its summary; `pr` is undefined if the state has none.
interface SummaryItem {
  issue: number;
  pr: number | null | undefined;
  stage: string | null;
  outcome: string;
  reason: string | null;
  allocatedTokens: number | null;
  rebaseAllocatedTokens: number | null;
}

// What the end-of-sweep cleanup did: ops' list of worktrees, or its error.
interface CleanupLog {
  worktrees: readonly unknown[];
  error: string | null;
}

interface SweepSummary {
  sweep: string;
  lane: string;
  repo: string;
  waiting: number;
  abandoned: readonly AbandonedClaim[];
  items: readonly SummaryItem[];
  parentsClosed: number;
  cleanup: CleanupLog;
}

interface StageMachine {
  next: (
    state: StageState,
    ctx: StageContext,
    results: readonly LaunchResult[],
  ) => Step;
}

export type {
  AbandonedClaim,
  ChildLaunch,
  ChildResult,
  ClaimStep,
  CleanupLog,
  Launch,
  LaunchResult,
  LaunchStep,
  ModelRole,
  OpLaunch,
  OpResult,
  StageCommands,
  StageComment,
  StageContext,
  StageMachine,
  StageName,
  StageState,
  StageStop,
  Step,
  StepEffects,
  SummaryItem,
  SweepCandidate,
  SweepConfig,
  SweepReply,
  SweepSummary,
  UnclaimedOutcome,
};
