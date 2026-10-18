// What a fix round does to the issue's findings (#418), ported from today's
// fix and rereview stages: the fixer's disputes, each recorded once on its
// finding, and the re-reviewers' verdicts, which resolve the findings every
// verdict closes, add the findings a fix introduced and stop on one it
// brought back or on a reply that doesn't read; with the comments each
// posts on the PR. Pure.

import { clip } from "../../workflow/clip.ts";
import type { FindingsStop } from "../../workflow/findings.ts";
import {
  ACCEPTANCE_REASON,
  acceptanceDisputeStop,
  addFinding,
  openFindings,
} from "../../workflow/findings.ts";
import type { Lens } from "../../workflow/lenses.ts";
import { ALL_LENSES } from "../../workflow/lenses.ts";
import type { Signature } from "../../workflow/signing.ts";
import type {
  Dispute,
  NewFinding,
  RereviewReply,
} from "../../workflow/stages/review-replies.ts";
import { rereviewReplyOf } from "../../workflow/stages/review-replies.ts";
import {
  fixComment,
  rereviewComment,
} from "../../workflow/stages/review-text.ts";
import type { Finding } from "../../workflow/types.ts";
import type { FixStop } from "./fix-data.ts";
import { findingsOf } from "./fix-data.ts";
import { FIXER_ROLE, REREVIEW_AGENT } from "./fix-task.ts";
import type { ImplData } from "./locate.ts";
import { IMPL_AGENT } from "./locate.ts";

// The longest dispute evidence a finding keeps.
const DISPUTE_LIMIT = 600;
// How many resolved findings the state remembers for recurrence checks.
const KEPT_RESOLVED = 30;
// The verdicts that close a finding.
const CLOSING: readonly string[] = ["resolved", "dispute-accepted"];
const REREVIEW_FAILED = "a re-reviewer failed";

// A signed comment for the `post` op.
interface PostComment {
  number: number;
  by: Signature;
  body: string;
}

// The findings after the round's verdicts, and the stop they gave, if any.
interface FindingsUpdate {
  findings: Finding[];
  resolvedHistory: string[];
  nextFindingId: number;
  stop: FixStop | null;
}

// The result update-findings answers with, its reply and its comments.
interface Updated {
  result: "resolved" | "open" | "reintroduced" | "bad";
  update: FindingsUpdate;
  comments: PostComment[];
}

// Records each dispute on its open finding, once.
function disputedFindings(
  findings: readonly Finding[],
  disputes: readonly Dispute[],
): Finding[] {
  return findings.map((finding: Finding): Finding => {
    const dispute = disputes.find((d) => d.id === finding.id);
    if (
      dispute === undefined ||
      finding.status !== "open" ||
      finding.disputed
    ) {
      return finding;
    }
    const evidence = clip(dispute.evidence, DISPUTE_LIMIT);
    return { ...finding, disputed: true, dispute: evidence };
  });
}

// The stop for an open acceptance finding the fixer disputed, null when
// there is none.
function disputedAcceptance(data: ImplData): FindingsStop | null {
  return acceptanceDisputeStop({ st: { findings: findingsOf(data.findings) } });
}

// The disputed acceptance finding's stop, for the end that names it.
function acceptanceStop(data: ImplData): FindingsStop {
  return (
    disputedAcceptance(data) ?? {
      reason: ACCEPTANCE_REASON,
      detail: "",
      code: "acceptance",
    }
  );
}

// Where the run's comments go: the PR once there is one, else the issue.
function commentNumber(data: ImplData): number {
  if (typeof data.pr === "number" && data.pr !== 0) {
    return data.pr;
  }
  return data.issue;
}

// The fixer's comment on its round, none before a reply that reads.
function fixerComments(data: ImplData): PostComment[] {
  if (data.fixReply === null) {
    return [];
  }
  const by: Signature = {
    role: `${FIXER_ROLE} (round ${data.fixRounds})`,
    agent: IMPL_AGENT,
    model: data.settings.models.fixer,
    run: data.by.run,
  };
  const body = fixComment(data.fixReply);
  return [{ number: commentNumber(data), by, body }];
}

function rereviewerComment(
  data: ImplData,
  lens: Lens,
  body: string,
): PostComment {
  const by: Signature = {
    role: `re-reviewer (${lens}, round ${data.fixRounds})`,
    agent: REREVIEW_AGENT,
    model: data.settings.models[lens],
    run: data.by.run,
  };
  return { number: commentNumber(data), by, body };
}

// The round so far: the findings with their next id, each finding's
// verdicts, and the comments.
interface Round {
  st: { findings: Finding[]; nextFindingId: number };
  verdicts: Map<string, string[]>;
  comments: PostComment[];
}

// Reads one lens's reply into `round`: the stop it gives, or null.
function readLens(
  data: ImplData,
  round: Round,
  lens: Lens,
  reply: RereviewReply,
): FixStop | null {
  for (const { id, status } of reply.results) {
    round.verdicts.set(id, [...(round.verdicts.get(id) ?? []), status]);
  }
  const added: Finding[] = [];
  const recurring: NewFinding[] = [];
  for (const finding of reply.newFindings) {
    if (finding.recursId === "") {
      added.push(addFinding(round, finding, [lens]));
    } else {
      recurring.push(finding);
    }
  }
  const body = rereviewComment(String(data.headSha), reply, added, recurring);
  round.comments.push(rereviewerComment(data, lens, body));
  const [back] = recurring;
  if (back === undefined) {
    return null;
  }
  return {
    reason: `a fix reintroduced finding ${back.recursId}; fixes are undoing each other`,
    detail: `${back.title}\n${back.evidence}`,
  };
}

// Resolves each open finding every verdict on it closes, remembering it.
function settled(data: ImplData, round: Round): FindingsUpdate {
  let history = [...data.resolvedHistory];
  const findings = round.st.findings.map((finding: Finding): Finding => {
    const statuses = round.verdicts.get(finding.id) ?? [];
    const closes =
      statuses.length > 0 &&
      statuses.every((status) => CLOSING.includes(status));
    if (finding.status !== "open" || !closes) {
      return finding;
    }
    history = [...history, `${finding.id}: ${finding.title}`];
    return { ...finding, status: "resolved" };
  });
  const { nextFindingId } = round.st;
  const resolvedHistory = history.slice(-KEPT_RESOLVED);
  return { findings, resolvedHistory, nextFindingId, stop: null };
}

// The round's update from the re-reviewers' replies, read in lens order up
// to the first that doesn't read or brings a finding back.
function updateOf(data: ImplData): Updated {
  const round: Round = {
    st: {
      findings: findingsOf(data.findings),
      nextFindingId: data.nextFindingId,
    },
    verdicts: new Map(),
    comments: [],
  };
  const unchanged = { ...round.st, resolvedHistory: data.resolvedHistory };
  for (const lens of ALL_LENSES) {
    const { [lens]: raw } = data.rereviews;
    if (raw !== undefined) {
      const reply = rereviewReplyOf(raw);
      if (reply === null) {
        const stop = { reason: REREVIEW_FAILED, detail: "" };
        const update = { ...unchanged, stop };
        return { result: "bad", update, comments: round.comments };
      }
      const stop = readLens(data, round, lens, reply);
      if (stop !== null) {
        const update = { ...unchanged, ...round.st, stop };
        return { result: "reintroduced", update, comments: round.comments };
      }
    }
  }
  const update = settled(data, round);
  let result: Updated["result"] = "open";
  if (openFindings({ st: update }).length === 0) {
    result = "resolved";
  }
  return { result, update, comments: round.comments };
}

export {
  acceptanceStop,
  disputedAcceptance,
  disputedFindings,
  fixerComments,
  updateOf,
};
