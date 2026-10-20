import { gherkinCommentOf } from "../gherkin-comment.ts";
import type { Inputs } from "./authentication.ts";
import { inputsFor, workerFor } from "./authentication.ts";
import { controls, developmentStage, issueAt } from "./eligibility.ts";
import {
  grantFor,
  handoffMatches,
  orchestrator,
  reviewEvidence,
} from "./grants.ts";
import { DiscoveryHold } from "./hold.ts";
import { same } from "./reads.ts";
import type { Issue, Pull, Repository, Settings, Worker } from "./schema.ts";
import type { Candidate, DiscoveryContext } from "./types.ts";

const CLOSES = /^Closes #(?<issue>[1-9]\d*)(?:\s|$)/u;
async function development(
  context: DiscoveryContext,
  issue: Issue,
  login: string,
): Promise<Candidate> {
  const { reads, settings, repo } = context;
  const worker = workerFor(settings.workers, repo.repo, login, "development");
  const inputs = await inputsFor(reads, repo, issue);
  await controls(reads, repo, issue, inputs);
  const event = await grantFor(context, issue.number, login, false);
  if (!(await orchestrator(reads, repo, event))) {
    throw new DiscoveryHold({
      reason: "provenance",
      evidence: `assignment:${event.id}:actor`,
    });
  }
  return {
    repository: repo.repo,
    kind: "issue",
    number: issue.number,
    login,
    issue: issue.number,
    worker: worker.worker,
    role: "development",
    stage: developmentStage(repo, issue, inputs),
    inputs: inputs.revision,
    grant: event.id,
    reviews: [],
  };
}

function recordedPull(repo: Repository, pull: Pull, inputs: Inputs): void {
  const { state } = inputs;
  if (
    state === null ||
    state.pr !== pull.number ||
    state.branch !== pull.head.ref ||
    state.headSha !== pull.head.sha ||
    !same(pull.user.login, repo.devAccount) ||
    !same(pull.head.repo.fullName, repo.repo) ||
    !same(pull.base.repo.fullName, repo.repo) ||
    pull.base.ref !== repo.baseBranch ||
    pull.state !== "open"
  ) {
    throw new DiscoveryHold({
      reason: "scope",
      evidence: `pull:${pull.number}:recorded-identity`,
    });
  }
}

function configuredReviewer(
  settings: Settings,
  repo: Repository,
  worker: Worker,
): boolean {
  const developer = workerFor(
    settings.workers,
    repo.repo,
    repo.devAccount,
    "development",
  );
  return (
    developer.reviewer !== undefined && same(developer.reviewer, worker.login)
  );
}

async function reviewGrant(
  context: DiscoveryContext,
  pull: Pull,
  binding: { worker: Worker; inputs: Inputs },
): Promise<import("./schema.ts").Event> {
  const { reads, settings, repo } = context;
  const { worker, inputs } = binding;
  const { login } = worker;
  const event = await grantFor(context, pull.number, login, true);
  if (!handoffMatches(inputs.handoff, pull, inputs, event)) {
    throw new DiscoveryHold({
      reason: "scope",
      evidence: `request:${event.id}:saved-handoff`,
    });
  }
  if (
    !(await orchestrator(reads, repo, event)) &&
    (!(
      same(event.actor?.login ?? "", repo.devAccount) &&
      configuredReviewer(settings, repo, worker)
    ) ||
      pull.requestedReviewers.length !== 1 ||
      pull.requestedTeams.length > 0)
  ) {
    throw new DiscoveryHold({
      reason: "scope",
      evidence: `request:${event.id}:development-handoff`,
    });
  }
  return event;
}

async function review(
  context: DiscoveryContext,
  pull: Pull,
  login: string,
): Promise<Candidate> {
  const { reads, settings, repo } = context;
  const worker = workerFor(settings.workers, repo.repo, login, "review");
  const { issue: linkedIssue } = CLOSES.exec(pull.body ?? "")?.groups ?? {};
  const issueNumber = Number(linkedIssue);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new DiscoveryHold({
      reason: "scope",
      evidence: `pull:${pull.number}:issue-link`,
    });
  }
  const issue = await issueAt(reads, repo, issueNumber);
  const inputs = await inputsFor(reads, repo, issue);
  await controls(reads, repo, issue, inputs);
  recordedPull(repo, pull, inputs);
  const { state } = inputs;
  if (state === null || !["review", "merge"].includes(state.stage)) {
    throw new DiscoveryHold({ reason: "role", evidence: "review-stage" });
  }
  if (
    state.gherkin?.inputs !== inputs.revision ||
    gherkinCommentOf(repo, issueNumber, inputs.comments)?.inputs !==
      inputs.revision
  ) {
    throw new DiscoveryHold({
      reason: "inputs",
      evidence: `return-to-author:${inputs.revision}`,
    });
  }
  const event = await reviewGrant(context, pull, { worker, inputs });
  const reviews = await reviewEvidence(reads, repo, pull, inputs);
  let stage: "review" | "merge" = "review";
  if (state.stage === "merge") {
    stage = "merge";
  }
  return {
    repository: repo.repo,
    kind: "pull",
    number: pull.number,
    login,
    issue: issueNumber,
    worker: worker.worker,
    role: "review",
    stage,
    inputs: inputs.revision,
    grant: event.id,
    reviews,
  };
}

export { development, review };
