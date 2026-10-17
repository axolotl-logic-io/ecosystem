// Re-review, the second half of a fix round: each lens with open findings
// judges the fix diff, its verdicts resolve findings, and its new findings
// join the open ones. A finding that comes back after being resolved stops
// the issue, since the fixes are undoing each other.

import { launchBudget } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { addFinding, openFindings } from "../findings.ts";
import type { Lens } from "../lenses.ts";
import { ALL_LENSES } from "../lenses.ts";
import { REREVIEW_SCHEMA, REREVIEW_SEC_SCHEMA } from "../review-schemas.ts";
import type { JsonSchema } from "../schemas.ts";
import type { Finding, IssueState } from "../types.ts";
import { rateLimitedIn, rateLimitStep } from "./rate-limit.ts";
import { patchIdIn } from "./reply-guards.ts";
import type { NewFinding, RereviewReply } from "./review-replies.ts";
import { rereviewReplyOf } from "./review-replies.ts";
import { rereviewComment, rereviewTask } from "./review-text.ts";
import { prepareLaunch } from "./stacked.ts";
import {
  codedStopStep,
  copyState,
  launchEach,
  launchStep,
  onlyReply,
  prComment,
  replyError,
  saveStep,
  sessionsOf,
  stopStep,
} from "./step.ts";
import type {
  ChildLaunch,
  ChildResult,
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  StageStop,
  Step,
} from "./types.ts";

const REREVIEW_MINUTES = 20;
// How many resolved findings the state remembers for recurrence checks.
const KEPT_RESOLVED = 30;
// The verdicts that close a finding.
const CLOSING: readonly string[] = ["resolved", "dispute-accepted"];

// The fix round the issue is in, 0 before the first.
function roundOf(state: StageState): number {
  return state.st.round ?? 0;
}

// The re-review diff's tag: the round, after the security round if any.
function prepTag(st: IssueState, round: number): string {
  const { securityRounds = 0 } = st;
  if (securityRounds === 0) {
    return `r${round}`;
  }
  return `s${securityRounds}-r${round}`;
}

// Prepares the diff since the last review for the fix round's re-reviewers.
function prepareRereview(state: StageState): Step {
  const { st } = state;
  const fields = { sinceSha: st.reviewedSha, tag: prepTag(st, roundOf(state)) };
  return launchStep({ ...state, phase: "prepared" }, [
    prepareLaunch(state, fields),
  ]);
}

function lensFindings(open: readonly Finding[], lens: Lens): Finding[] {
  return open.filter((f) => f.lenses.includes(lens));
}

// The lenses with open findings, in ALL_LENSES order.
function openLenses(state: StageState): Lens[] {
  const open = openFindings(state);
  return ALL_LENSES.filter((lens) => lensFindings(open, lens).length > 0);
}

function schemaOf(lens: Lens): JsonSchema {
  if (lens === "security") {
    return REREVIEW_SEC_SCHEMA;
  }
  return REREVIEW_SCHEMA;
}

function rereviewLaunch(
  ctx: StageContext,
  state: StageState,
  lens: Lens,
  diffPath: string,
): ChildLaunch {
  const findings = lensFindings(openFindings(state), lens);
  return {
    kind: "child",
    name: `rereview-${lens}-r${roundOf(state)}`,
    label: `Re-review ${lens} fixes for issue ${state.n}`,
    agent: "issue-pipeline-reader",
    model: ctx.models[lens],
    schema: schemaOf(lens),
    minutes: REREVIEW_MINUTES,
    ...launchBudget(ctx.budgets, "rereviewer"),
    task: rereviewTask(ctx, state, { lens, diffPath, findings }),
  };
}

// What the re-reviewers said so far: the verdicts on each finding, their
// comments, and the stop, once one fails or a finding comes back.
interface Rereviews {
  st: IssueState;
  verdicts: Map<string, string[]>;
  comments: StageComment[];
  stop: StageStop | null;
}

// Resolves each open finding every verdict on it closes, records the head as
// reviewed, moves to checks on the branch as it stands, with every check to
// run, and records the patch id the round's diff named, when none is open,
// then saves.
function settle(
  state: StageState,
  ctx: StageContext,
  { st, verdicts, comments }: Rereviews,
): Step {
  for (const finding of st.findings) {
    const statuses = verdicts.get(finding.id) ?? [];
    if (
      finding.status === "open" &&
      statuses.length > 0 &&
      statuses.every((status) => CLOSING.includes(status))
    ) {
      finding.status = "resolved";
      st.resolvedHistory = (st.resolvedHistory ?? [])
        .concat([`${finding.id}: ${finding.title}`])
        .slice(-KEPT_RESOLVED);
    }
  }
  st.reviewedSha = st.headSha ?? null;
  if (openFindings({ st }).length === 0) {
    st.stage = "checks";
    st.testsOnly = false;
    st.reviewedPatchId = patchIdIn(state.carry);
    const text = `fix round ${roundOf(state)}: all findings resolved; checks run without a rebase`;
    noteEvent(st, text, ctx.now());
  }
  return saveStep({ ...state, st, phase: "saved" }, comments);
}

// Launches a re-reviewer for each lens with open findings on the fix diff. With none to launch, the round settles at once.
function launchRereviews(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = onlyReply(results);
  const { ok, error, diffPath } = reply;
  if (ok !== true) {
    return stopStep(
      state,
      "could not prepare the re-review diff",
      replyError(error),
    );
  }
  const lenses = openLenses(state);
  const st = copyState(state.st);
  const prepared = { ...state, carry: { patchId: patchIdIn(reply) } };
  if (lenses.length === 0) {
    return settle(prepared, ctx, {
      st,
      verdicts: new Map(),
      comments: [],
      stop: null,
    });
  }
  const rereviewing = { ...prepared, st, phase: "rereviewed" };
  return launchEach(
    rereviewing,
    lenses.map((lens) =>
      rereviewLaunch(ctx, rereviewing, lens, String(diffPath)),
    ),
  );
}

// Reads one re-reviewer's reply into `rereviews`.
function readRereview(
  rereviews: Rereviews,
  state: StageState,
  lens: Lens,
  result: ChildResult,
): void {
  let reply: RereviewReply | null = null;
  if (result.ok) {
    reply = rereviewReplyOf(result.structuredOutput);
  }
  if (reply === null) {
    const { error } = result;
    rereviews.stop = {
      reason: "a re-reviewer failed",
      detail: error,
      code: null,
    };
    return;
  }
  for (const { id, status } of reply.results) {
    rereviews.verdicts.set(id, [...(rereviews.verdicts.get(id) ?? []), status]);
  }
  const added: Finding[] = [];
  const recurring: NewFinding[] = [];
  for (const finding of reply.newFindings) {
    if (finding.recursId === "") {
      added.push(addFinding(rereviews, finding, [lens]));
    } else {
      recurring.push(finding);
    }
  }
  const { st } = rereviews;
  const by = {
    ...result.by,
    role: `re-reviewer (${lens}, round ${roundOf(state)})`,
  };
  const body = rereviewComment(String(st.headSha), reply, added, recurring);
  rereviews.comments.push(prComment(by, body));
  const [back] = recurring;
  if (back !== undefined) {
    const reason = `a fix reintroduced finding ${back.recursId}; fixes are undoing each other`;
    const detail = `${back.title}\n${back.evidence}`;
    rereviews.stop = { reason, detail, code: null };
  }
}

// Reads the re-reviewers' replies in lens order, stopping at the first that
// fails or brings a finding back, then settles the round.
function settleRereviews(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const rereviews: Rereviews = {
    st: copyState(state.st),
    verdicts: new Map(),
    comments: [],
    stop: null,
  };
  if (rateLimitedIn(results)) {
    return rateLimitStep(state, "a re-reviewer failed", ctx.now());
  }
  for (const { name, result } of sessionsOf(openLenses(state), results)) {
    readRereview(rereviews, state, name, result);
    const { stop, st, comments } = rereviews;
    if (stop !== null) {
      return codedStopStep({ ...state, st }, stop, comments);
    }
  }
  return settle(state, ctx, rereviews);
}

export { launchRereviews, prepareRereview, roundOf, settleRereviews };
