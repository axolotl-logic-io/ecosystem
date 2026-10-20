import { AFTER_MARK, PARENT_MARK } from "../comment-marks.ts";
import { gherkinCommentOf } from "../gherkin-comment.ts";
import { isStopLabel } from "../stops.ts";
import type { Inputs } from "./authentication.ts";
import { DiscoveryHold } from "./hold.ts";
import type { Reads } from "./reads.ts";
import type { Issue, Repository } from "./schema.ts";
import { ISSUE } from "./schema.ts";
import type { Candidate } from "./types.ts";

async function issueAt(
  reads: Reads,
  repo: Repository,
  number: number,
): Promise<Issue> {
  const value = ISSUE.safeParse(
    await reads.get(repo.repo, `/repos/${repo.repo}/issues/${number}`),
  );
  if (
    !value.success ||
    value.data.number !== number ||
    value.data.pullRequest !== undefined
  ) {
    throw new DiscoveryHold({
      reason: "read",
      evidence: `issue:${number}`,
      incomplete: true,
    });
  }
  return value.data;
}

async function controls(
  reads: Reads,
  repo: Repository,
  issue: Issue,
  inputs: Inputs,
): Promise<void> {
  localControls(repo, issue, inputs);
  const body = issue.body ?? "";
  if (
    (body.includes("<!-- agent-pipeline:after") && !AFTER_MARK.test(body)) ||
    (body.includes("<!-- agent-pipeline:parent") && !PARENT_MARK.test(body))
  ) {
    throw new DiscoveryHold({
      reason: "dependency",
      evidence: "malformed-markers",
      incomplete: true,
    });
  }
  const { after } = AFTER_MARK.exec(issue.body ?? "")?.groups ?? {};
  for await (const number of (after ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)) {
    if ((await issueAt(reads, repo, number)).state !== "closed") {
      throw new DiscoveryHold({
        reason: "dependency",
        evidence: `after:${number}`,
      });
    }
  }
  // Parent is a relationship, not an after/prerequisite. Reading it does not
  // manufacture a new dependency or require the parent to be closed.
  const { parent } = PARENT_MARK.exec(issue.body ?? "")?.groups ?? {};
  if (parent !== undefined) {
    await issueAt(reads, repo, Number(parent));
  }
}

function localControls(repo: Repository, issue: Issue, inputs: Inputs): void {
  const { state, revision } = inputs;
  const labels = issue.labels.map((label) => label.name);
  if (issue.state !== "open" || state?.stage === "done") {
    throw new DiscoveryHold({ reason: "role", evidence: "closed-or-done" });
  }
  if (
    labels.some(isStopLabel) ||
    state?.stage === "stopped" ||
    (state?.stopCode !== null && state?.stopCode !== undefined)
  ) {
    throw new DiscoveryHold({ reason: "stop", evidence: "active-stop" });
  }
  savedControls(inputs);
  if (
    labels.includes("agent:split") ||
    labels.includes("agent:merged") ||
    labels.some((label) => repo.skipLabels.includes(label)) ||
    (state === null && !repo.takeNewWork)
  ) {
    throw new DiscoveryHold({ reason: "scope", evidence: "excluded-issue" });
  }
  if (
    state?.asked?.inputs === revision ||
    (labels.includes("agent:needs-info") &&
      (state === null || state.asked === null))
  ) {
    throw new DiscoveryHold({
      reason: "needs-info",
      evidence: `unanswered:${revision}`,
    });
  }
}

function savedControls(inputs: Inputs): void {
  const { state } = inputs;
  if (
    (state?.mergeAttempt !== null && state?.mergeAttempt !== undefined) ||
    (state?.codeMerged !== null && state?.codeMerged !== undefined) ||
    (state?.merged !== null && state?.merged !== undefined) ||
    (state?.security !== null && state?.security !== undefined)
  ) {
    throw new DiscoveryHold({
      reason: "state",
      evidence: "postmerge-reconciliation",
    });
  }
}

function developmentStage(
  repo: Repository,
  issue: Issue,
  inputs: Inputs,
): Candidate["stage"] {
  const { state, revision, comments } = inputs;
  const gherkin = gherkinCommentOf(repo, issue.number, comments);
  if (
    state === null ||
    state.stage === "author" ||
    state.gherkin?.inputs !== revision ||
    gherkin?.inputs !== revision
  ) {
    return "author";
  }
  if (
    state.stage !== "implement" ||
    state.codeMerged !== null ||
    state.mergeAttempt !== null
  ) {
    throw new DiscoveryHold({
      reason: "role",
      evidence: `development:${state.stage}`,
    });
  }
  return "implement";
}

export { controls, developmentStage, issueAt };
