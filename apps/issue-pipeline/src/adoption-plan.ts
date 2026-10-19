// The reconciliation record and its fresh, deliberately empty authorization.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TRUTH } from "./adoption-identity.ts";
import type { Preservation } from "./adoption-preservation.ts";
import {
  PRESERVATION,
  verifyEvidence,
  workIdentity,
} from "./adoption-preservation.ts";
import { liveClaims } from "./claims.ts";
import { isStateBody } from "./comment-marks.ts";
import type { IssueComment } from "./comments.ts";
import { COMMENT } from "./comments.ts";
import type { Config } from "./config.ts";
import { OpsError } from "./ops-error.ts";
import { redactLocalPaths } from "./pipeline-root.ts";
import { rawStateBody } from "./saved-state.ts";
import type { IssueState } from "./state.ts";
import { newIssueState } from "./state.ts";

const REQUEST = z.object({
  issue: z.number().int().positive(),
  branch: z.string().min(1),
  code: z.string().min(1),
  wiki: z.string().min(1).optional(),
  restart: z.string().optional(),
});
type AdoptionRequest = z.infer<typeof REQUEST>;
const PLAN = z.object({
  version: z.literal(1),
  request: REQUEST,
  truth: TRUTH,
  comments: z.array(COMMENT),
  work: PRESERVATION,
});
type Plan = z.infer<typeof PLAN>;
function saveJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function currentStates(
  cfg: Config,
  comments: readonly IssueComment[],
): IssueComment[] {
  return comments.filter(
    (item) =>
      item.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase() &&
      isStateBody(item.body ?? "") &&
      z
        .object({ version: z.literal(2) })
        .safeParse(rawStateBody(item.body ?? "")).success,
  );
}

function historicalComments(
  cfg: Config,
  comments: readonly IssueComment[],
): IssueComment[] {
  const current = new Set(currentStates(cfg, comments).map((item) => item.id));
  return comments.filter((item) => !current.has(item.id));
}

function assertNoClaim(cfg: Config, comments: readonly IssueComment[]): void {
  if (liveClaims(cfg, comments).length > 0) {
    throw new OpsError(
      "a live claim exists; stop dispatch and drain jobs before adoption",
    );
  }
}

function restartState(plan: Plan, evidence: string, hash: string): IssueState {
  const { truth, request } = plan;
  const { restart } = request;
  if (restart === undefined) {
    throw new OpsError(
      "operator must choose an explicit --restart-stage (author, or stopped for closed/merged work)",
    );
  }
  const blocked = truth.prState === "CLOSED" || truth.prState === "MERGED";
  if (
    (!blocked && restart !== "author") ||
    (blocked && restart !== "stopped")
  ) {
    throw new OpsError(
      "restart stage lacks current authorization: choose author for open work; closed/merged work must choose stopped for explicit PR/completion reconciliation",
    );
  }
  const chosen = z.enum(["author", "stopped"]).parse(restart);
  const state = newIssueState(request.issue);
  let codeMerged: IssueState["codeMerged"] = null;
  if (truth.pr !== null && truth.merge !== null) {
    codeMerged = { pr: truth.pr, sha: truth.merge };
  }
  let stage: IssueState["stage"] = "author";
  let stoppedStage: IssueState["stoppedStage"] = null;
  let stopCode: string | null = null;
  if (blocked) {
    stage = "stopped";
    stoppedStage = "author";
    stopCode = "legacy-reconciliation";
  }
  return {
    ...state,
    stage,
    stoppedStage,
    stopCode,
    branch: truth.branch,
    pr: truth.pr,
    headSha: truth.head ?? truth.prHead,
    codeMerged,
    adoption: {
      evidence: redactLocalPaths(evidence),
      digest: hash,
      repo: truth.repo,
      restart: chosen,
      blocked,
    },
    log: [
      "Explicit operator adoption; historical approvals grant no current authorization. See adoption evidence.",
    ],
  };
}

function sameObservation(left: unknown, right: unknown, what: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new OpsError(
      `${what} changed or conflicts with adoption; retain evidence and reconcile explicitly`,
    );
  }
}

// Completed snapshots survive an interruption before plan/publication. Reuse
// only after an independent new snapshot proves the retained work is unchanged.
function reusablePreservation(
  root: string,
  current: Preservation,
  dest: string,
): Preservation {
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    const inventory = path.join(dir, "inventory.json");
    if (
      name.startsWith("snapshot-") &&
      dir !== dest &&
      fs.existsSync(inventory)
    ) {
      const saved = PRESERVATION.parse(
        JSON.parse(fs.readFileSync(inventory, "utf8")),
      );
      verifyEvidence(saved);
      if (workIdentity(saved) === workIdentity(current)) {
        return saved;
      }
    }
  }
  return current;
}

export type { AdoptionRequest, Plan };
export {
  assertNoClaim,
  currentStates,
  historicalComments,
  PLAN,
  REQUEST,
  restartState,
  reusablePreservation,
  sameObservation,
  saveJson,
};
