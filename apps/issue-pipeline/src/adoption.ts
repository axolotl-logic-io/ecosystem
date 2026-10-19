// Deterministic explicit operator reconciliation, with no stage launch.
import fs from "node:fs";
import path from "node:path";
import { validateGraph } from "./adoption-graph.ts";
import { inspectTruth, validateLegacy } from "./adoption-identity.ts";
import type { AdoptionRequest, Plan } from "./adoption-plan.ts";
import {
  assertNoClaim,
  currentStates,
  historicalComments,
  PLAN,
  REQUEST,
  restartState,
  reusablePreservation,
  sameObservation,
  saveJson,
} from "./adoption-plan.ts";
import type { Preservation } from "./adoption-preservation.ts";
import {
  digest,
  preserveWork,
  verifyEvidence,
  workIdentity,
} from "./adoption-preservation.ts";
import type { IssueComment } from "./comments.ts";
import { listComments, rawComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { withRepoLock } from "./locks.ts";
import { OpsError } from "./ops-error.ts";
import { readWriteState, stateBody } from "./saved-state.ts";
import type { IssueState } from "./state.ts";

interface AdoptionReply {
  evidence: string;
  state: IssueState;
  reused: boolean;
}

interface Attempt {
  request: AdoptionRequest;
  root: string;
  evidence: string;
  dest: string;
  comments: IssueComment[];
  work: Preservation;
}

function preservedAttempt(
  cfg: Config,
  request: AdoptionRequest,
  root: string,
): Attempt {
  const evidence = path.join(root, "plan.json");
  const dest = fs.mkdtempSync(path.join(root, "snapshot-"));
  const comments = listComments(cfg, request.issue);
  saveJson(path.join(dest, "comments.json"), comments);
  const snapshot = preserveWork(cfg, request, dest);
  const work = reusablePreservation(root, snapshot, dest);
  saveJson(path.join(dest, "inventory.json"), work);
  assertNoClaim(cfg, comments);
  return { request, root, evidence, dest, comments, work };
}

function preparedPlan(cfg: Config, context: Attempt): Plan {
  const { request, evidence, dest, comments, work } = context;
  if (fs.existsSync(evidence)) {
    const plan = PLAN.parse(JSON.parse(fs.readFileSync(evidence, "utf8")));
    sameObservation(plan.request, request, "operator decision/selected work");
    verifyEvidence(plan.work);
    sameObservation(
      workIdentity(plan.work),
      workIdentity(work),
      "retained local work",
    );
    sameObservation(
      plan.comments,
      historicalComments(cfg, comments),
      "historical state/handoffs",
    );
    return plan;
  }
  if (currentStates(cfg, comments).length > 0) {
    throw new OpsError(
      "existing current state conflicts with adoption; no matching local publication evidence",
    );
  }
  const legacyPr = validateLegacy(cfg, request, comments);
  const truth = inspectTruth(cfg, request, legacyPr);
  const plan: Plan = { version: 1, request, truth, comments, work };
  validateGraph(cfg, plan, dest);
  restartState(plan, evidence, "pending");
  saveJson(evidence, plan);
  return plan;
}

function confirmedAuthority(
  cfg: Config,
  request: AdoptionRequest,
  expected: IssueState,
): IssueState {
  const saved = readWriteState(cfg, request.issue);
  sameObservation(expected, saved, "confirmed saved authority");
  return saved;
}

function revalidatePublication(
  cfg: Config,
  context: Attempt,
  plan: Plan,
  latest: IssueComment[],
): void {
  const { root, request } = context;
  const check = fs.mkdtempSync(path.join(root, "snapshot-"));
  const work = preserveWork(cfg, request, check);
  saveJson(path.join(check, "inventory.json"), work);
  sameObservation(
    workIdentity(plan.work),
    workIdentity(work),
    "retained local work",
  );
  const legacyPr = validateLegacy(cfg, request, plan.comments);
  sameObservation(
    plan.truth,
    inspectTruth(cfg, request, legacyPr),
    "actual repository/PR/wiki identity or head",
  );
  sameObservation(
    latest,
    listComments(cfg, request.issue),
    "current saved authority/comments",
  );
  verifyEvidence(plan.work);
}

function publish(
  cfg: Config,
  context: Attempt,
  plan: Plan,
  expected: IssueState,
): AdoptionReply {
  const { request, evidence, root } = context;
  const latest = listComments(cfg, request.issue);
  assertNoClaim(cfg, latest);
  sameObservation(
    plan.comments,
    historicalComments(cfg, latest),
    "historical state/handoffs",
  );
  const current = currentStates(cfg, latest);
  if (current.length > 0) {
    if (current.length !== 1) {
      throw new OpsError(
        "multiple current state comments conflict with adoption",
      );
    }
    const marker = JSON.parse(
      fs.readFileSync(path.join(root, "publication-started.json"), "utf8"),
    );
    sameObservation(
      marker,
      { evidence, digest: digest(fs.readFileSync(evidence)) },
      "publication evidence",
    );
    return {
      evidence,
      state: confirmedAuthority(cfg, request, expected),
      reused: true,
    };
  }
  const started = path.join(root, "publication-started.json");
  if (fs.existsSync(started)) {
    throw new OpsError(
      "publication is uncertain: no matching current state visible; inspect GitHub and retain evidence, do not retry or delete the publication marker blindly",
    );
  }
  revalidatePublication(cfg, context, plan, latest);
  saveJson(started, { evidence, digest: digest(fs.readFileSync(evidence)) });
  rawComment(cfg, request.issue, stateBody(request.issue, expected));
  const state = confirmedAuthority(cfg, request, expected);
  return { evidence, state, reused: false };
}

function attempt(
  cfg: Config,
  request: AdoptionRequest,
  root: string,
): AdoptionReply {
  // Always preserve first, even on refusal/replay. Existing snapshots and
  // partial preparations are never replaced or automatically applied.
  const context = preservedAttempt(cfg, request, root);
  const plan = preparedPlan(cfg, context);
  const legacyPr = validateLegacy(cfg, request, plan.comments);
  const fresh = inspectTruth(cfg, request, legacyPr);
  sameObservation(
    plan.truth,
    fresh,
    "actual repository/PR/wiki identity or head",
  );
  validateGraph(cfg, { ...plan, truth: fresh }, context.dest);
  const expected = restartState(
    plan,
    context.evidence,
    digest(fs.readFileSync(context.evidence)),
  );
  return publish(cfg, context, plan, expected);
}

function adoptLegacy(cfg: Config, raw: AdoptionRequest): AdoptionReply {
  const parsed = REQUEST.parse(raw);
  const root = path.join(paths.runDir(cfg, parsed.issue), "adoption");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return withRepoLock(cfg, `adopt-${parsed.issue}`, () => {
    try {
      const request: AdoptionRequest = {
        ...parsed,
        code: fs.realpathSync(parsed.code),
      };
      if (parsed.wiki !== undefined) {
        request.wiki = fs.realpathSync(parsed.wiki);
      }
      return attempt(cfg, request, root);
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) {
        ({ message } = error);
      }
      throw new OpsError(
        `adoption refused: ${message}. Inventory/recovery: ${root}. Keep all retained checkouts and evidence; resolve the named uncertainty before any restart.`,
        { cause: error },
      );
    }
  });
}

export type { AdoptionReply };
export { adoptLegacy };
