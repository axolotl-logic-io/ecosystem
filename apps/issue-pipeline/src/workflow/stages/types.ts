// The step machine the sweep runs its stages on. A stage is a sync `next`
// that takes the issue's JSON-safe state and the results of the launches it
// asked for last, and returns its next step: more launches, or done. The
// sweep's top-level loop does the launching, and applies the comments and the
// stop each step carries, so no stage awaits anything.

import type { Budgets } from "../budget.ts";
import type { JsonSchema } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import type {
  FixRoundsConfig,
  IssueState,
  ItemPaths,
  PracticesConfig,
  RepoConfig,
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
  | "merge";

// The issue as a stage sees it. `phase` is the stage's own position, "begin"
// on its first call.
interface StageState {
  n: number;
  paths: ItemPaths;
  st: IssueState;
  closed: boolean;
  // Why the issue is closed for this sweep, such as "split", or null.
  outcome: string | null;
  phase: string;
  // JSON-safe data the stage passes to its own next step within one sweep,
  // null at "begin". It is never saved.
  carry: unknown;
}

// A model session. The sweep keys it "i<n>-<name>-<seq>".
interface ChildLaunch {
  kind: "child";
  name: string;
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

// A finished session, signed with its launch's name as the role.
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
  | "security";

interface StageConfig extends RepoConfig, PracticesConfig, FixRoundsConfig {
  maxTriages: number;
}

// What every stage reads besides the issue: the repo config, the token
// budgets, the models and the clock.
interface StageContext {
  cfg: StageConfig;
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
  now: () => Date;
}

interface StageMachine {
  next: (
    state: StageState,
    ctx: StageContext,
    results: readonly LaunchResult[],
  ) => Step;
}

export type {
  ChildLaunch,
  ChildResult,
  Launch,
  LaunchResult,
  OpLaunch,
  OpResult,
  StageComment,
  StageContext,
  StageMachine,
  StageName,
  StageState,
  StageStop,
  Step,
};
