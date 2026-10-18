// A role's ops and comments in a stage job (src/job/role-run.ts): each op
// runs through the job's op runner (src/job/ops-request.ts) with the timeout
// this module gives it, and a failed one throws OpsFailure. A role's comment
// is a signed, keyed comment the post op writes on the issue or its PR,
// returning its id.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { IssueState } from "../state.ts";
import type { RunOp } from "./ops-request.ts";
import type {
  CommentRole,
  JobOpName,
  OpName,
  PostedComment,
} from "./role-context.ts";
import { OpsFailure } from "./role-context.ts";
import { STAGE_AGENTS } from "./roles.ts";

// The code of every OpsFailure the job throws (role-context.ts).
const OPS_FAILED = 1;
// The minutes an op may run when it waits on checks: verify runs the repo's
// commands, ci-status waits for CI and cleanup frees worktrees; every other
// op has the runner's 10.
const VERIFY_MINUTES = 120;
const CI_MARGIN_MINUTES = 10;
const CLEANUP_MINUTES = 30;
// The config's CI wait, which loadConfig always fills from its defaults.
const CI_WAIT = z.looseObject({ ciWaitMinutes: z.number().positive() });
const POSTED = z.looseObject({
  commentIds: z.array(z.number().int().positive()).min(1),
});

// What the ops read of their job.
interface OpsJob {
  cfg: Config;
  issue: number;
  key: string;
  runOp: RunOp;
}

// A comment's signer, as the post and ask ops take it.
interface Signer {
  role: CommentRole;
  agent: string | null;
  model: string | null;
  run: string;
}

function minutesOf(cfg: Config, op: OpName | JobOpName): number | undefined {
  switch (op) {
    case "verify":
      return VERIFY_MINUTES;
    case "ci-status":
      return CI_WAIT.parse(cfg).ciWaitMinutes + CI_MARGIN_MINUTES;
    case "cleanup":
      return CLEANUP_MINUTES;
    default:
      return undefined;
  }
}

// An op's reply: its fields after `ok`.
type OpFields = Readonly<Record<string, unknown>>;

type RoleOpRunner = (
  op: OpName | JobOpName,
  payload: object,
) => Promise<OpFields>;

// The job's op runner for a role: runs `op` with `payload` and resolves to
// its reply's fields, or throws OpsFailure with its error.
function opRunnerOf(job: OpsJob): RoleOpRunner {
  return async (op: OpName | JobOpName, payload: object): Promise<OpFields> => {
    const reply = await job.runOp(op, payload, minutesOf(job.cfg, op));
    if (!reply.ok) {
      throw new OpsFailure(op, OPS_FAILED, reply.error);
    }
    return reply.reply;
  };
}

// The signer of `role`'s comments in the job: a model role's agent and
// configured model, or the merger, which runs none; and the job's key.
function signerOf(job: OpsJob, role: CommentRole): Signer {
  let agent: string | null = null;
  let model: string | null = null;
  const stage = Object.values(STAGE_AGENTS).find(
    (entry) => entry?.role === role,
  );
  if (stage !== undefined && stage !== null) {
    ({ agent } = stage);
    model = job.cfg.models[stage.role];
  }
  return { role, agent, model, run: job.key };
}

// The job's comment poster: `post` writes `comment` on the issue, or on the
// PR the state `current()` names (a role with no PR yet gets OpsFailure),
// and returns its id; `by` is a role's signer.
function postOf(
  job: OpsJob,
  current: () => IssueState,
): {
  post: (comment: PostedComment) => Promise<number>;
  by: (role: CommentRole) => Signer;
} {
  const run = opRunnerOf(job);
  return {
    by: (role: CommentRole): Signer => signerOf(job, role),
    post: async (comment: PostedComment): Promise<number> => {
      let number = job.issue;
      if (comment.on === "pr") {
        const { pr } = current();
        if (pr === null) {
          throw new OpsFailure(
            "post",
            OPS_FAILED,
            "the issue has no PR to post on",
          );
        }
        number = pr;
      }
      const { key, body } = comment;
      const by = signerOf(job, comment.role);
      const reply = await run("post", {
        comments: [{ number, key, body, by }],
      });
      const posted = POSTED.safeParse(reply);
      if (!posted.success) {
        throw new OpsFailure(
          "post",
          OPS_FAILED,
          "the post op returned no comment id",
        );
      }
      const [id] = posted.data.commentIds;
      if (id === undefined) {
        throw new OpsFailure(
          "post",
          OPS_FAILED,
          "the post op returned no comment id",
        );
      }
      return id;
    },
  };
}

export type { OpFields, OpsJob, RoleOpRunner, Signer };
export { opRunnerOf, postOf };
