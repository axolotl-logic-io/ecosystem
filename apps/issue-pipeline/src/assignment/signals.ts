import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import type { IssueState } from "../state.ts";
import type { Hub } from "./github.ts";
import { pages } from "./github.ts";
import type { Worker } from "./schema.ts";
import { DEFAULT_PAGE_BUDGET } from "./schema.ts";
import type { Event, IssueRow, Pull, Review } from "./signal-schema.ts";
import { EVENT, PR, REVIEW } from "./signal-schema.ts";

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function workerOf(cfg: Config, id: string): Worker {
  const matches =
    cfg.assignment?.workers.filter((entry) => entry.id === id) ?? [];
  const [worker] = matches;
  if (matches.length !== 1 || worker === undefined) {
    throw new OpsError(`missing or ambiguous worker mapping: ${id}`);
  }
  let account = cfg.devAccount;
  if (worker.roles === "review") {
    account = cfg.mergeAccount;
  }
  if (!same(worker.login, account)) {
    throw new OpsError(
      `worker ${id} must map to its configured ${worker.roles} account`,
    );
  }
  return worker;
}
function orchestrator(hub: Hub, cfg: Config, event: Event): boolean {
  const login = event.actor?.login;
  return (
    login !== undefined && (same(login, cfg.mergeAccount) || hub.allowed(login))
  );
}
function eventsFor(hub: Hub, cfg: Config, number: number): Event[] {
  return pages(
    hub,
    `issues/${number}/events`,
    EVENT,
    cfg.assignment?.pageBudget ?? DEFAULT_PAGE_BUDGET,
  ).sort((a, b) => a.id - b.id);
}
function developmentGrant(
  hub: Hub,
  cfg: Config,
  issue: IssueRow,
  worker: Worker,
): Event {
  if (issue.state !== "open" || !hub.allowed(issue.user.login)) {
    throw new OpsError(
      "issue is closed or its author is not a trusted collaborator",
    );
  }
  if (!issue.assignees.some((assignee) => same(assignee.login, worker.login))) {
    throw new OpsError("assignment withdrawn");
  }
  const last = eventsFor(hub, cfg, issue.number).findLast(
    (event) =>
      ["assigned", "unassigned"].includes(event.event) &&
      same(event.assignee?.login ?? "", worker.login),
  );
  if (
    last === undefined ||
    last.event !== "assigned" ||
    !orchestrator(hub, cfg, last)
  ) {
    throw new OpsError(
      "ignored assignment: missing or unauthorized actor provenance",
    );
  }
  return last;
}
function reviewGrant(
  hub: Hub,
  cfg: Config,
  issue: IssueRow,
  binding: { state: IssueState; worker: Worker },
): Event {
  const { state, worker } = binding;
  if (
    (issue.state !== "open" && state.codeMerged === null) ||
    !hub.allowed(issue.user.login)
  ) {
    throw new OpsError("issue closed or author untrusted");
  }
  const handoff = state.coordination?.handoff;
  if (
    handoff === undefined ||
    handoff === null ||
    state.pr === null ||
    handoff.checkpoint.pr !== state.pr ||
    handoff.checkpoint.branch !== state.branch
  ) {
    throw new OpsError("review request has no matching durable handoff");
  }
  const pr = PR.parse(hub.read(`pulls/${state.pr}`));
  assertPullIdentity(cfg, state, pr);
  const assignment = eventsFor(hub, cfg, issue.number).findLast(
    (item) =>
      item.event === "assigned" &&
      same(item.assignee?.login ?? "", cfg.devAccount),
  );
  if (assignment?.id !== handoff.assignment && state.codeMerged === null) {
    throw new OpsError("development reassignment cancels review ownership");
  }
  if (changeRequest(hub, cfg, state) !== undefined) {
    throw new OpsError("bound changes requested: return to development");
  }
  const events = eventsFor(hub, cfg, state.pr);
  const event = events.findLast(
    (item) =>
      ["review_requested", "review_request_removed"].includes(item.event) &&
      same(item.requested_reviewer?.login ?? "", worker.login),
  );
  if (event === undefined) {
    throw new OpsError("review request actor cannot be verified");
  }
  const fromDeveloper =
    same(event.actor?.login ?? "", cfg.devAccount) &&
    Date.parse(event.created_at) >= Date.parse(handoff.checkpoint.at);
  if (!(orchestrator(hub, cfg, event) || fromDeveloper)) {
    throw new OpsError("ignored review request: unauthorized actor");
  }
  assertRequestBinding({ hub, cfg, pr, state, handoff, worker }, event);
  return event;
}

function assertPullIdentity(cfg: Config, state: IssueState, pr: Pull): void {
  if (
    pr.number !== state.pr ||
    !same(pr.user.login, cfg.devAccount) ||
    pr.head.repo.full_name !== cfg.repo ||
    pr.base.repo.full_name !== cfg.repo ||
    pr.head.ref !== state.branch ||
    pr.base.ref !== cfg.baseBranch ||
    !["open", "closed"].includes(pr.state)
  ) {
    throw new OpsError("review PR identity disagrees with saved handoff");
  }
  const accepted = state.coordination?.handoff?.phase === "accepted";
  if (accepted && pr.head.sha !== state.headSha && state.codeMerged === null) {
    throw new OpsError("external head change invalidates review ownership");
  }
}
interface RequestBinding {
  hub: Hub;
  cfg: Config;
  pr: Pull;
  state: IssueState;
  worker: Worker;
  handoff: NonNullable<NonNullable<IssueState["coordination"]>["handoff"]>;
}
function assertRequestBinding(binding: RequestBinding, event: Event): void {
  const { hub, cfg, pr, handoff, worker } = binding;
  if (Date.parse(event.created_at) < Date.parse(handoff.checkpoint.at)) {
    throw new OpsError("request predates saved handoff");
  }
  if (handoff.phase === "accepted") {
    if (
      handoff.request === null ||
      (event.event === "review_requested" && event.id !== handoff.request)
    ) {
      throw new OpsError("accepted handoff was replaced");
    }
    if (event.event === "review_request_removed") {
      const consumed = reviewsFor(hub, cfg, pr.number).some(
        (review) =>
          !handoff.reviewsBefore.includes(review.id) &&
          same(event.actor?.login ?? "", worker.login) &&
          same(review.user.login, cfg.mergeAccount) &&
          review.commit_id === pr.head.sha &&
          review.submitted_at !== null &&
          Date.parse(review.submitted_at) >= Date.parse(handoff.checkpoint.at),
      );
      if (!consumed) {
        throw new OpsError("accepted review handoff cancelled");
      }
    }
  } else if (
    event.event !== "review_requested" ||
    (handoff.request === null && handoff.eventsBefore.includes(event.id)) ||
    (handoff.request !== null && handoff.request !== event.id) ||
    !pr.requested_reviewers.some((user) => same(user.login, worker.login)) ||
    pr.head.sha !== handoff.checkpoint.code
  ) {
    throw new OpsError("pending request and durable handoff disagree");
  }
}

function reviewsFor(hub: Hub, cfg: Config, pr: number): Review[] {
  return pages(
    hub,
    `pulls/${pr}/reviews`,
    REVIEW,
    cfg.assignment?.pageBudget ?? DEFAULT_PAGE_BUDGET,
  );
}
function changeRequest(
  hub: Hub,
  cfg: Config,
  state: IssueState,
): Review | undefined {
  const handoff = state.coordination?.handoff;
  if (
    state.pr === null ||
    handoff === undefined ||
    handoff === null ||
    state.codeMerged !== null ||
    state.merged !== null
  ) {
    return undefined;
  }
  const pr = PR.parse(hub.read(`pulls/${state.pr}`));
  return reviewsFor(hub, cfg, state.pr)
    .filter(
      (review) =>
        same(review.user.login, cfg.mergeAccount) &&
        !handoff.reviewsBefore.includes(review.id) &&
        review.state === "CHANGES_REQUESTED" &&
        review.commit_id === pr.head.sha &&
        review.commit_id === handoff.checkpoint.code &&
        review.id !== handoff.review &&
        review.submitted_at !== null &&
        Date.parse(review.submitted_at) >= Date.parse(handoff.checkpoint.at),
    )
    .at(-1);
}

export {
  assertPullIdentity,
  changeRequest,
  developmentGrant,
  eventsFor,
  reviewGrant,
  same,
  workerOf,
};
