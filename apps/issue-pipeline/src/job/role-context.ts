// The contract between a stage job and the role it runs (`src/roles/`): a
// role is a plain async function of one RoleContext that returns how the
// stage ended. The job owns everything around it: the claim, the checkouts,
// stop and steer, job.json, applying the end (save-state, stop, ask,
// release), the exit push and teardown. A role never claims or releases,
// never runs git or gh itself, and imports no other role's modules.

import type { z } from "zod";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import type { ModelRole } from "../config-legacy.ts";
import type { GherkinComment } from "../gherkin-comment.ts";
import type { Issue } from "../issue-context.ts";
import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";

// The ops a role may ask for; each runs in its own `ops.mjs` process, the
// only code that holds a token. The job alone runs claim, save-state, stop,
// ask, release, usage and exit-push. `current-revision` reads the issue's
// trusted inputs, the checkout's code head and the PR afresh from
// GitHub (shared-ops-contract.md).
type OpName =
  | "current-revision"
  | "post"
  | "start-pr"
  | "open-pr"
  | "push"
  | "sync-base"
  | "finish-sync"
  | "prepare-review"
  | "verify"
  | "ci-status"
  | "merge"
  | "reconcile-merge"
  | "finish-wiki"
  | "ready-pr"
  | "cleanup";

// The ops only the job runs, around and after the role.
type JobOpName =
  | "claim"
  | "save-state"
  | "stop"
  | "ask"
  | "release"
  | "usage"
  | "exit-push";

type AgentName =
  | "issue-pipeline-author"
  | "issue-pipeline-implementor"
  | "issue-pipeline-reviewer";

// The role a comment is signed with.
type CommentRole = ModelRole | "merger";

// The issue's trusted inputs as the job read them at its start.
interface RoleInputs {
  issue: Issue;
  comments: readonly IssueComment[];
  // trustedInputsHash over them (issue-context.ts).
  revision: string;
  // The issue's Gherkin comment, or null before the author's first.
  gherkin: GherkinComment | null;
}

// The reviewer's states a session may be labelled with: hardening (review
// stage) and integration (merge stage) commit; the security review, in the
// merge stage after integration, only reads.
const SESSION_PHASES = ["hardening", "security-review", "integration"] as const;

type SessionPhase = (typeof SESSION_PHASES)[number];

// One `pi --mode rpc` session as `agent`. `schema` is the reply's schema,
// which the session's structured_output tool enforces. `commits` is this
// session's own write authority, whatever its agent: only a session with
// `commits` gets `pipeline_commit`, its commit scope and tools that edit or
// run commands. `phase`, when given, labels its records and must agree with
// `commits` and the stage (sessionRefusalOf in roles.ts).
interface SessionSpec {
  agent: AgentName;
  model: string;
  task: string;
  schema: z.ZodType;
  commits: boolean;
  phase?: SessionPhase;
}

// A session's reply, already checked against its schema; or why it failed,
// `transient` for a provider's rate limit or a transport error.
type SessionResult =
  | { ok: true; reply: unknown }
  | { ok: false; transient: boolean; error: string };

interface PostedComment {
  // The keyed comment's key: posting the same key again edits it in place.
  key: string;
  on: "issue" | "pr";
  role: CommentRole;
  body: string;
}

// A failed op: its name, and its error as the message. The job's ops replies
// carry no exit code, so `code` is always 1 (OPS_FAILED in role-ops.ts).
// `opError` is the op's own reply error, unchanged, which alone decides
// whether the failure is transient (src/job/transient.ts); it is null for a
// failure the job found itself, such as a reply missing a field.
// The code of every OpsFailure.
const OPS_FAILED = 1;

class OpsFailure extends Error {
  readonly code: number;
  readonly op: OpName | JobOpName;
  readonly opError: string | null;

  constructor(
    op: OpName | JobOpName,
    code: number,
    message: string,
    opError: string | null = null,
  ) {
    super(message);
    this.name = "OpsFailure";
    this.code = code;
    this.op = op;
    this.opError = opError;
  }
}

interface RoleContext {
  cfg: Config;
  issue: number;
  stage: Stage;
  // The claimed state.
  state: IssueState;
  // The job's folder and its code checkout repo/.
  dirs: { job: string; repo: string };
  // The filtered issue file: the issue and its trusted comments.
  issueFile: string;
  inputs: RoleInputs;
  // The merge order the orchestrator ranked (`--merge-queue`), or null.
  mergeQueue: readonly number[] | null;
  // Runs one op and returns its reply; throws OpsFailure when it fails.
  op: (name: OpName, payload: object) => Promise<unknown>;
  session: (spec: SessionSpec) => Promise<SessionResult>;
  // A signed, keyed comment, created or edited in place; returns its id.
  post: (comment: PostedComment) => Promise<number>;
  // Saves the state mid-run, as a checkpoint after a push.
  save: (state: IssueState) => Promise<void>;
}

// How a role's stage ended; the job applies it.
type RoleEnd =
  // `state.stage` is already the next stage, or "done".
  | { kind: "next"; state: IssueState }
  | { kind: "stop"; code: string; reason: string; state: IssueState }
  // Post the questions, label the issue agent:needs-info and wait at author.
  | { kind: "ask"; questions: readonly string[]; state: IssueState }
  // Stay at this stage for the next job, such as a queued merge.
  | { kind: "wait"; reason: string; state: IssueState }
  // A transient failure: nothing is counted and the orchestrator backs off.
  | { kind: "deferred"; error: string };

type Role = (ctx: RoleContext) => Promise<RoleEnd>;

// The failure for an op reply that isn't what a role reads. The job found
// it itself, so it is never transient: the job stops with `error`.
function unreadableReply(op: OpName, detail: string): OpsFailure {
  return new OpsFailure(
    op,
    OPS_FAILED,
    `its reply is not what the role reads: ${detail}`,
  );
}

export type {
  AgentName,
  CommentRole,
  JobOpName,
  OpName,
  PostedComment,
  Role,
  RoleContext,
  RoleEnd,
  RoleInputs,
  SessionPhase,
  SessionResult,
  SessionSpec,
};
export { OPS_FAILED, OpsFailure, SESSION_PHASES, unreadableReply };
