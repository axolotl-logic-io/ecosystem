import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import type { IssueState } from "../state.ts";
import { pages } from "./github.ts";
import type { Coordination, Worker } from "./schema.ts";
import { DEFAULT_PAGE_BUDGET } from "./schema.ts";
import type { IssueRow, Review } from "./signal-schema.ts";
import { PR, REVIEW } from "./signal-schema.ts";
import {
  assertPullIdentity,
  changeRequest,
  developmentGrant,
  eventsFor,
  reviewGrant,
} from "./signals.ts";
import type { WorkerDeps } from "./worker-state.ts";
import { requiredState, saveCoordination } from "./worker-state.ts";

function fixesFor(
  cfg: Config,
  deps: WorkerDeps,
  issue: IssueRow,
  state: IssueState,
): {
  coord: Coordination;
  handoff: NonNullable<Coordination["handoff"]>;
  changes: Review | undefined;
  developer: Worker | undefined;
} | null {
  const coord = state.coordination;
  if (
    coord?.handoff === null ||
    coord === null ||
    coord === undefined ||
    state.codeMerged !== null ||
    state.merged !== null
  ) {
    return null;
  }
  const changes = changeRequest(deps.hub, cfg, state);
  const developer = cfg.assignment?.workers.find(
    (worker) => worker.roles === "development",
  );
  let reassigned = false;
  if (developer !== undefined) {
    const event = developmentGrant(deps.hub, cfg, issue, developer);
    reassigned = event.id !== coord.handoff.assignment;
  }
  if (changes === undefined && !reassigned) {
    return null;
  }
  return { coord, handoff: coord.handoff, changes, developer };
}
function returnForFixes(
  cfg: Config,
  deps: WorkerDeps,
  issue: IssueRow,
  state: IssueState,
): IssueState {
  const fixes = fixesFor(cfg, deps, issue, state);
  if (fixes === null) {
    return state;
  }
  const { coord, handoff, changes, developer } = fixes;
  const next: IssueState = {
    ...state,
    stage: "implement",
    hardened: null,
    integration: null,
    security: null,
    verifiedSha: null,
    coordination: {
      ...coord,
      handoff: null,
      worker: developer?.id ?? null,
      status: "queued",
      reason: "authenticated changes/reassignment returned work to development",
    },
  };
  if (changes !== undefined) {
    applyReview(deps, next, changes, handoff.checkpoint);
  }
  deps.save(issue.number, next);
  return requiredState(deps, issue.number);
}

function applyReview(
  deps: WorkerDeps,
  next: IssueState,
  changes: Review,
  checkpoint: NonNullable<Coordination["checkpoint"]>,
): void {
  // Review bodies remain operational evidence; never append them to trusted
  // human inputs or pretend that a bot answered the Author's questions.

  deps.notice(
    next.number,
    `Review #${changes.id} requests development fixes at ${changes.commit_id}: ${changes.body ?? ""}`,
  );
  next.review = {
    ...next.review,
    verdict: "changes",
    findings: [
      {
        id: changes.id,
        severity: "blocking",
        text: changes.body ?? "Review requested changes",
      },
    ],
    revision: {
      code: changes.commit_id,
      wiki: checkpoint.wiki,
      inputs: checkpoint.inputs,
    },
  };
}

function prepareHandoff(
  cfg: Config,
  deps: WorkerDeps,
  context: { state: IssueState; issue: IssueRow },
): IssueState {
  const { state, issue } = context;
  const coord = state.coordination;
  const checkpoint = coord?.checkpoint;
  if (
    coord === null ||
    checkpoint === undefined ||
    checkpoint === null ||
    state.pr === null ||
    checkpoint.code !== state.headSha ||
    checkpoint.inputs !== state.gherkin?.inputs
  ) {
    throw new OpsError(
      "ready for handoff without confirmed source/wiki checkpoint and PR; reconcile publication",
    );
  }
  const developer = cfg.assignment?.workers.find(
    (worker) => worker.roles === "development",
  );
  if (developer === undefined) {
    throw new OpsError("missing developer mapping");
  }
  const assignment = developmentGrant(deps.hub, cfg, issue, developer).id;
  const bound = { ...checkpoint, pr: state.pr, at: deps.now().toISOString() };
  const handoff: Coordination["handoff"] = {
    id: crypto.randomUUID(),
    assignment,
    eventsBefore: eventsFor(deps.hub, cfg, state.pr).map((event) => event.id),
    reviewsBefore: pages(
      deps.hub,
      `pulls/${state.pr}/reviews`,
      REVIEW,
      cfg.assignment?.pageBudget ?? DEFAULT_PAGE_BUDGET,
    ).map((review) => review.id),
    checkpoint: bound,
    phase: "pending",
    request: null,
    review: null,
  };
  return saveCoordination(deps, state, {
    ...coord,
    status: "ready-for-handoff",
    handoff,
  });
}
function requestHandoff(
  cfg: Config,
  deps: WorkerDeps,
  issue: IssueRow,
  state: IssueState,
): IssueState {
  let saved = state;
  if (saved.coordination?.handoff === null) {
    saved = prepareHandoff(cfg, deps, { state: saved, issue });
  }
  const coord = saved.coordination;
  const handoff = coord?.handoff;
  const reviewer = cfg.assignment?.workers.find(
    (worker) => worker.roles === "review",
  );
  if (
    coord === undefined ||
    coord === null ||
    handoff === undefined ||
    handoff === null ||
    reviewer === undefined ||
    saved.pr === null
  ) {
    throw new OpsError("missing review mapping or handoff");
  }
  if (handoff.phase !== "pending") {
    return saved;
  }
  // Reconcile a request whose response was lost before considering a POST.
  // If the outcome is uncertain after POST, pending state plus the retained
  // execution ref prevents blind replay on restart.
  const pr = PR.parse(deps.hub.read(`pulls/${saved.pr}`));
  assertPullIdentity(cfg, saved, pr);
  eventsFor(deps.hub, cfg, saved.pr);
  if (
    pr.requested_reviewers.some(
      (user) => user.login.toLowerCase() === reviewer.login.toLowerCase(),
    )
  ) {
    const event = reviewGrant(deps.hub, cfg, issue, {
      state: saved,
      worker: reviewer,
    });
    return saveCoordination(deps, saved, {
      ...coord,
      pending: null,
      handoff: { ...handoff, phase: "requested", request: event.id },
    });
  }
  return publishRequest({ cfg, deps, issue, saved, coord, handoff, reviewer });
}

interface Request {
  cfg: Config;
  deps: WorkerDeps;
  issue: IssueRow;
  saved: IssueState;
  coord: Coordination;
  handoff: NonNullable<Coordination["handoff"]>;
  reviewer: Worker;
}
function publishRequest(request: Request): IssueState {
  const { cfg, deps, issue, coord, handoff, reviewer } = request;
  let { saved } = request;
  if (coord.pending !== null) {
    throw new OpsError("uncertain review request; reconcile, do not repeat");
  }
  saved = saveCoordination(deps, saved, {
    ...coord,
    pending: {
      kind: "review-request",
      expected: handoff.checkpoint.code,
      at: deps.now().toISOString(),
    },
  });
  deps.hub.create(
    `pulls/${saved.pr}/requested_reviewers`,
    { reviewers: [reviewer.login] },
    "dev",
  );
  const event = reviewGrant(deps.hub, cfg, issue, {
    state: saved,
    worker: reviewer,
  });
  return saveCoordination(deps, saved, {
    ...coord,
    pending: null,
    handoff: { ...handoff, phase: "requested", request: event.id },
  });
}

export { fixesFor, requestHandoff, returnForFixes };
