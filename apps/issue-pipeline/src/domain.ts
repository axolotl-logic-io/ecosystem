// The shared domain of buddies and tasks (docs/domain-runtime-contract.md):
// the schemas of every value that crosses a component boundary, and the
// interfaces the task, signal and runtime components implement against one
// another. It imports no runtime, signal or task implementation; every
// boundary value is parsed with these schemas rather than asserted.

import { z } from "zod";
import type { Config } from "./config.ts";

// The five delivery tasks and Safe Refactor.
const TASK_IDS = [
  "author",
  "implement",
  "verify",
  "fix",
  "land",
  "refactor-safely",
] as const;
// Author and Implement bind the trusted requirements; every other task binds
// a revision: for Verify, Fix and Land the item PR's head, which is the item
// branch's head.
const REQUIREMENTS_TASKS = ["author", "implement"] as const;
const REVISION_TASKS = ["verify", "fix", "land", "refactor-safely"] as const;
// The tasks a start label requests on the issue.
const START_TASKS = ["author", "implement", "verify"] as const;
// At most this many Fix rounds that Verify's request-changes triggered, per
// work item; after them a further request-changes holds the item for a
// person.
const VERIFY_FIX_ROUNDS = 3;

const TASK_ID = z.enum(TASK_IDS);
const ROLE_ID = z.enum(["developer", "gatekeeper"]);
const ACCESS_PROFILE = z.enum(["reader", "writer", "lander"]);
const RUN_STATE = z.enum(["running", "waiting", "stopped", "ended"]);
const VERDICT = z.enum(["passed", "failed", "refused", "unknown"]);

const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/u);
const REQUIREMENTS = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const UUID = z.uuid();

const WORK_ITEM_REF = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  number: z.number().int().positive(),
});
const TARGET_STATE = z.strictObject({
  branch: z.string().min(1),
  commit: SHA,
});
const REVISION = z.strictObject({ code: SHA, inputs: DIGEST, policy: DIGEST });
const RUN_REF = z.strictObject({ id: UUID, previous: UUID.nullable() });

const BINDING = z.union([
  z.strictObject({
    workItem: WORK_ITEM_REF,
    task: z.enum(REQUIREMENTS_TASKS),
    target: TARGET_STATE,
    requirements: REQUIREMENTS,
  }),
  z.strictObject({
    workItem: WORK_ITEM_REF,
    task: z.enum(REVISION_TASKS),
    target: TARGET_STATE,
    revision: REVISION,
  }),
]);

const HUMAN_PROVENANCE = z.strictObject({
  route: z.literal("human"),
  login: z.string().min(1),
  userId: z.number().int().positive(),
  organization: z.string().min(1),
});

const SIGNAL_ID = z.string().min(1);
const RECORD_ID = z.number().int().positive();
const PR_NUMBER = z.number().int().positive();

// The states of a submitted GitHub PR review that bind a head: an approval
// or a request for changes. A comment-only or dismissed review binds none.
const REVIEW_STATE = z.enum(["APPROVED", "CHANGES_REQUESTED"]);
// One submitted PR review: GitHub's review id, its PR, the head commit it was
// submitted against (`commit_id`) and its state.
const PR_REVIEW = z.strictObject({
  id: z.number().int().positive(),
  pr: PR_NUMBER,
  commit: SHA,
  state: REVIEW_STATE,
});

// A start requests one task for the issue: Author or Implement for the
// requirements and target read when it was accepted, Verify for the head of
// the issue's linked PR read then.
const START_SIGNAL = z.discriminatedUnion("task", [
  z.strictObject({
    kind: z.literal("start"),
    id: SIGNAL_ID,
    workItem: WORK_ITEM_REF,
    task: z.enum(["author", "implement"]),
    requirements: REQUIREMENTS,
    target: TARGET_STATE,
    provenance: HUMAN_PROVENANCE,
    recordId: RECORD_ID,
  }),
  z.strictObject({
    kind: z.literal("start"),
    id: SIGNAL_ID,
    workItem: WORK_ITEM_REF,
    task: z.literal("verify"),
    pr: PR_NUMBER,
    head: SHA,
    target: TARGET_STATE,
    provenance: HUMAN_PROVENANCE,
    recordId: RECORD_ID,
  }),
]);

const QUALIFIED_SIGNAL = z.discriminatedUnion("kind", [
  START_SIGNAL,
  // A qualified person's submitted review of the issue's linked PR, accepted
  // as a record like a label: CHANGES_REQUESTED on the current head wakes
  // Fix, APPROVED on it counts toward Land. The landing account's reviews are
  // Verify's results, never review signals.
  z.strictObject({
    kind: z.literal("review"),
    id: SIGNAL_ID,
    workItem: WORK_ITEM_REF,
    review: PR_REVIEW,
    provenance: HUMAN_PROVENANCE,
    recordId: RECORD_ID,
  }),
  z.strictObject({
    kind: z.literal("stop"),
    id: SIGNAL_ID,
    workItem: WORK_ITEM_REF,
    provenance: HUMAN_PROVENANCE,
    recordId: RECORD_ID,
  }),
  z.strictObject({
    kind: z.literal("result"),
    id: SIGNAL_ID,
    workItem: WORK_ITEM_REF,
    binding: BINDING,
    recordId: RECORD_ID,
    producerRun: UUID,
  }),
]);

const EVIDENCE_HOLD = z.strictObject({
  workItem: WORK_ITEM_REF.nullable(),
  reason: z.string().min(1),
});
const SIGNAL_INBOX = z.strictObject({
  signals: z.array(QUALIFIED_SIGNAL).readonly(),
  holds: z.array(EVIDENCE_HOLD).readonly(),
  complete: z.boolean(),
});

const ACTION_CAUSE = z.strictObject({
  signal: SIGNAL_ID,
  recordId: RECORD_ID,
});

const MAX_SUMMARY = 300;
const RECEIPT = z.strictObject({
  summary: z.string().min(1).max(MAX_SUMMARY),
  // The revision a writer task, Implement or Fix, produced; the merge commit
  // a Land delivered.
  produced: z.strictObject({ code: SHA }).optional(),
  evidence: z.json().optional(),
});

// What a determined Verify result's receipt evidence holds: the review it
// submitted through the landing account, bound to exactly its binding's
// code. Its verdict mirrors the review: passed for APPROVED, refused for
// CHANGES_REQUESTED. `blocking` and `nits` count its findings; `security`
// says whether a Security finding was among the blocking ones.
const VERIFY_EVIDENCE = z.strictObject({
  review: PR_REVIEW,
  blocking: z.number().int().nonnegative(),
  nits: z.number().int().nonnegative(),
  security: z.boolean(),
});

// What a determined Land result's receipt evidence holds. A passed Land
// merged the PR at exactly its checked head with a merge commit and closed
// the issue; a Land that found the approved PR conflicting with its base
// marked it a draft, and its refused result says why, which wakes Fix.
const LAND_EVIDENCE = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("merged"),
    pr: PR_NUMBER,
    head: SHA,
    mergeCommit: SHA,
    issueClosed: z.literal(true),
  }),
  z.strictObject({
    outcome: z.literal("conflict"),
    pr: PR_NUMBER,
    head: SHA,
    base: TARGET_STATE,
    reason: z.string().min(1),
  }),
]);

const TASK_RESULT = z.strictObject({
  binding: BINDING,
  run: RUN_REF,
  buddyRun: UUID,
  // The signal that caused the run, as its attempt recorded it.
  cause: ACTION_CAUSE,
  verdict: VERDICT,
  receipt: RECEIPT,
  recordId: RECORD_ID,
});

const READINESS = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("ready"), binding: BINDING }),
  // The task's own unsettled binding, which only its read-only recovery may
  // settle: never a new attempt.
  z.strictObject({
    state: z.literal("recover"),
    binding: BINDING,
    reason: z.string().min(1),
  }),
  z.strictObject({
    state: z.enum(["waiting", "held", "stopped"]),
    reason: z.string().min(1),
  }),
]);

const ACTION_END = z.strictObject({
  state: RUN_STATE,
  outcome: z.enum(["succeeded", "failed", "refused", "unknown"]).nullable(),
  reason: z.string().min(1),
  verdict: VERDICT,
  produced: z.strictObject({ code: SHA }).optional(),
});

type TaskId = z.infer<typeof TASK_ID>;
type RoleId = z.infer<typeof ROLE_ID>;
type AccessProfile = z.infer<typeof ACCESS_PROFILE>;
type Verdict = z.infer<typeof VERDICT>;
type WorkItemRef = z.infer<typeof WORK_ITEM_REF>;
type TargetState = z.infer<typeof TARGET_STATE>;
type Revision = z.infer<typeof REVISION>;
type RunRef = z.infer<typeof RUN_REF>;
type Binding = z.infer<typeof BINDING>;
type RevisionBinding = Extract<Binding, { revision: unknown }>;
type HumanProvenance = z.infer<typeof HUMAN_PROVENANCE>;
type PrReview = z.infer<typeof PR_REVIEW>;
type ReviewState = z.infer<typeof REVIEW_STATE>;
type StartTask = (typeof START_TASKS)[number];
type VerifyEvidence = z.infer<typeof VERIFY_EVIDENCE>;
type LandEvidence = z.infer<typeof LAND_EVIDENCE>;
type QualifiedSignal = z.infer<typeof QUALIFIED_SIGNAL>;
type EvidenceHold = z.infer<typeof EVIDENCE_HOLD>;
type SignalInbox = z.infer<typeof SIGNAL_INBOX>;
type ActionCause = z.infer<typeof ACTION_CAUSE>;
type Receipt = z.infer<typeof RECEIPT>;
type TaskResult = z.infer<typeof TASK_RESULT>;
type Readiness = z.infer<typeof READINESS>;
type ActionEnd = z.infer<typeof ACTION_END>;

// A work item's current task evidence, read fresh (src/tasks/view.ts): the
// trusted requirements digest, revision R (null before any code), the
// configured target's tip T, and the item's authenticated v2 results.
// `hold` names evidence that holds every task of the item. A run with no
// settled verdict reads as verdict unknown. `permissions` is the trusted
// repository configuration's grant as read: a scheduling observation only,
// which every effect checks again for itself.
interface TaskView {
  workItem: WorkItemRef;
  requirements: string;
  revision: Revision | null;
  target: TargetState;
  containsTarget: boolean;
  results: readonly TaskResult[];
  hold: string | null;
  permissions: { land: boolean };
}

interface SessionSpec {
  agent:
    | "issue-pipeline-author"
    | "issue-pipeline-developer"
    | "issue-pipeline-reviewer";
  model: string;
  task: string;
  schema: z.ZodType;
  commits: boolean;
  // Implement's fresh hardening session, Verify's Security review and Fix's
  // session; a task's first or only session has no phase.
  phase?: "hardening" | "security-review" | "fix";
}

type SessionResult =
  | { ok: true; reply: unknown }
  | { ok: false; transient: boolean; error: string };

// What the runtime gives one admitted action: its identities, its cause, its
// binding and checkout, and the effect boundaries every task effect crosses.
interface ActionContext {
  cfg: Config;
  workItem: WorkItemRef;
  buddyRun: string;
  run: RunRef;
  cause: ActionCause;
  binding: Binding;
  checkout: { root: string; repo: string; branch: string };
  stop: AbortSignal;
  boundary: (name: string) => Promise<void>;
  op: (name: string, payload: object) => Promise<unknown>;
  // Prepares the checkout's test environment once, for a task holding a
  // test slot: the configured setup with the issue's leased lane slot. It
  // rejects for recovery, for a task with no test slot and when setup fails;
  // a failed setup retains the checkout and its slot.
  prepare: () => Promise<void>;
  session: (spec: SessionSpec) => Promise<SessionResult>;
  checkpoint: (detail: object) => Promise<void>;
}

interface TaskDefinition {
  id: TaskId;
  role: RoleId;
  access: AccessProfile;
  sensors: readonly QualifiedSignal["kind"][];
  resources: readonly ("model-session" | "test-slot" | "target-write")[];
  match: (signal: QualifiedSignal, view: TaskView) => Readiness | null;
  act: (ctx: ActionContext) => Promise<ActionEnd>;
  // Read-only reconciliation of the task's own unsettled run, for a
  // `recover` readiness: it settles that original run from reads alone and
  // never repeats its effects.
  recover?: (ctx: ActionContext) => Promise<ActionEnd>;
}

function isRevisionBinding(binding: Binding): binding is RevisionBinding {
  return "revision" in binding;
}

function subjectOf(binding: Binding): string[] {
  if (isRevisionBinding(binding)) {
    const { code, inputs, policy } = binding.revision;
    return ["revision", code, inputs, policy];
  }
  return ["requirements", binding.requirements];
}

// Every part of a binding, in a fixed order, so equal bindings compare equal
// whatever their key order.
function bindingKey(binding: Binding): string {
  const subject = subjectOf(binding);
  return JSON.stringify([
    binding.workItem.repo.toLowerCase(),
    binding.workItem.number,
    binding.task,
    ...subject,
    binding.target.branch,
    binding.target.commit,
  ]);
}

function sameBinding(a: Binding, b: Binding): boolean {
  return bindingKey(a) === bindingKey(b);
}

export type {
  AccessProfile,
  ActionCause,
  ActionContext,
  ActionEnd,
  Binding,
  EvidenceHold,
  HumanProvenance,
  LandEvidence,
  PrReview,
  QualifiedSignal,
  Readiness,
  Receipt,
  ReviewState,
  Revision,
  RevisionBinding,
  RoleId,
  RunRef,
  SessionResult,
  SessionSpec,
  SignalInbox,
  StartTask,
  TargetState,
  TaskDefinition,
  TaskId,
  TaskResult,
  TaskView,
  Verdict,
  VerifyEvidence,
  WorkItemRef,
};
export {
  ACCESS_PROFILE,
  ACTION_CAUSE,
  ACTION_END,
  BINDING,
  bindingKey,
  DIGEST,
  EVIDENCE_HOLD,
  HUMAN_PROVENANCE,
  isRevisionBinding,
  LAND_EVIDENCE,
  MAX_SUMMARY,
  PR_REVIEW,
  QUALIFIED_SIGNAL,
  READINESS,
  RECEIPT,
  REQUIREMENTS,
  REVIEW_STATE,
  REVISION,
  ROLE_ID,
  RUN_REF,
  RUN_STATE,
  SHA,
  SIGNAL_ID,
  SIGNAL_INBOX,
  START_TASKS,
  sameBinding,
  TARGET_STATE,
  TASK_ID,
  TASK_RESULT,
  UUID,
  VERDICT,
  VERIFY_EVIDENCE,
  VERIFY_FIX_ROUNDS,
  WORK_ITEM_REF,
};
