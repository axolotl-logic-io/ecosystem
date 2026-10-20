import type { Inputs } from "./authentication.ts";
import { human } from "./authentication.ts";
import { DiscoveryHold } from "./hold.ts";
import { type Reads, same } from "./reads.ts";
import type { Event, Handoff, Pull, Repository } from "./schema.ts";
import { EVENT, REVIEW } from "./schema.ts";
import type { DiscoveryContext } from "./types.ts";

async function grantFor(
  context: DiscoveryContext,
  number: number,
  login: string,
  reviewing: boolean,
): Promise<Event> {
  const { reads, repo } = context;
  const events = await reads.pages(
    repo.repo,
    `/repos/${repo.repo}/issues/${number}/events`,
    EVENT,
  );
  const ids = events.map((event) => event.id);
  if (new Set(ids).size !== ids.length) {
    throw new DiscoveryHold({
      reason: "page",
      evidence: `events:${number}:duplicate`,
      incomplete: true,
    });
  }
  let kinds = ["assigned", "unassigned"];
  if (reviewing) {
    kinds = ["review_requested", "review_request_removed"];
  }
  const latest = events
    .toSorted((a, b) => a.id - b.id)
    .findLast((event) => {
      let target = event.assignee?.login;
      if (reviewing) {
        target = event.requestedReviewer?.login;
      }
      return kinds.includes(event.event) && same(target ?? "", login);
    });
  if (latest === undefined || latest.actor === null) {
    throw new DiscoveryHold({
      reason: "provenance",
      evidence: `grant:${number}:${login}:absent`,
      incomplete: true,
    });
  }
  if (latest.event !== kinds[0]) {
    throw new DiscoveryHold({
      reason: "provenance",
      evidence: `grant:${latest.id}:withdrawn`,
    });
  }
  return latest;
}

async function orchestrator(
  reads: Reads,
  repo: Repository,
  event: Event,
): Promise<boolean> {
  const actor = event.actor?.login ?? "";
  return same(actor, repo.mergeAccount) || (await human(reads, repo, actor));
}

function handoffMatches(
  handoff: Handoff | null,
  pull: Pull,
  inputs: Inputs,
  event: Event,
): boolean {
  if (handoff === null) {
    return false;
  }
  const { checkpoint } = handoff;
  return (
    checkpoint.pr === pull.number &&
    checkpoint.branch === pull.head.ref &&
    checkpoint.code === pull.head.sha &&
    checkpoint.inputs === inputs.revision &&
    Date.parse(event.createdAt) >= Date.parse(checkpoint.at) &&
    !handoff.eventsBefore.includes(event.id) &&
    (handoff.request === event.id || handoff.request === null)
  );
}

async function reviewEvidence(
  reads: Reads,
  repo: Repository,
  pull: Pull,
  inputs: Inputs,
): Promise<number[]> {
  const reviews = await reads.pages(
    repo.repo,
    `/repos/${repo.repo}/pulls/${pull.number}/reviews`,
    REVIEW,
  );
  const accepted: number[] = [];
  for (const item of reviews.filter((entry) =>
    same(entry.user.login, repo.mergeAccount),
  )) {
    if (
      !same(
        item.pullUrl,
        `https://api.github.com/repos/${repo.repo}/pulls/${pull.number}`,
      ) ||
      inputs.state?.pr !== pull.number ||
      item.commit !== pull.head.sha ||
      inputs.handoff?.checkpoint.code !== item.commit ||
      inputs.handoff.checkpoint.pr !== pull.number ||
      inputs.handoff.checkpoint.branch !== pull.head.ref ||
      inputs.handoff.checkpoint.inputs !== inputs.revision ||
      inputs.handoff.review !== item.id ||
      item.submittedAt === null ||
      Date.parse(item.submittedAt) < Date.parse(inputs.handoff.checkpoint.at) ||
      !["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(item.state)
    ) {
      throw new DiscoveryHold({
        reason: "provenance",
        evidence: `review:${item.id}:binding`,
      });
    }
    accepted.push(item.id);
  }
  if (
    inputs.handoff?.review !== null &&
    inputs.handoff?.review !== undefined &&
    !accepted.includes(inputs.handoff.review)
  ) {
    throw new DiscoveryHold({
      reason: "provenance",
      evidence: `review:${inputs.handoff.review}:absent`,
      incomplete: true,
    });
  }
  return accepted;
}

export { grantFor, handoffMatches, orchestrator, reviewEvidence };
