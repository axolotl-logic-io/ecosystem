// Claim comments. Lanes may run on different machines, so they coordinate on
// GitHub. A lane claims an issue by commenting, reads the issue's comments
// back, and proceeds only if its claim is the earliest live one. A claim is live until it is closed (edited to
// `claim-closed`) or goes leaseHours without an edit. The winner's claim stays
// live while its lane works the issue, across sweeps: each sweep's release
// edits it (touchClaim). It is closed when the issue leaves the pipeline:
// merged, stopped, asking or split.

import { CLAIM_MARK, PIPELINE_MARK } from "./comment-marks.ts";
import type { IssueComment } from "./comments.ts";
import {
  COMMENT,
  editComment,
  listComments,
  pipelineRole,
  signed,
} from "./comments.ts";
import type { Config } from "./config.ts";
import { ghJson } from "./github.ts";
import { LABELS, setLabels } from "./labels.ts";

const MS_PER_HOUR = 3_600_000;
const STAMP_LENGTH = 16;
const STILL_WORKING_AT_END = /\n<sub>Lane still working at [^<]*<\/sub>$/u;
const STILL_WORKING = /<sub>Lane still working at [^<]*<\/sub>$/u;
// A claim that stays open only expires later, so a failed edit isn't fatal.
const QUIET = { allowFail: true };

// The request fields that name the lane: its own name, or its sweep's id.
interface LaneRequest {
  lane?: unknown;
  sweepId?: unknown;
}

interface Claim {
  id: number;
  lane: string;
  sweep: string;
  body: string;
}

// What raceForClaim found: `won`, and when another lane holds the issue, its
// lane as `holder`; `posted` says whether this lane commented.
interface ClaimRace {
  won: boolean;
  claimId?: number;
  holder?: string | null;
  posted: boolean;
}

function laneOf(req: LaneRequest): string {
  const { lane, sweepId } = req;
  if (lane === undefined || lane === null || lane === "") {
    return String(sweepId);
  }
  return String(lane);
}

// The lane named in an issue's lease, if it has one.
function leaseLane(lease: LaneRequest | null | undefined): unknown {
  if (lease === undefined || lease === null) {
    return lease;
  }
  const { lane, sweepId } = lease;
  if (lane === undefined || lane === null || lane === "") {
    return sweepId;
  }
  return lane;
}

function minuteStamp(): string {
  return `${new Date().toISOString().slice(0, STAMP_LENGTH)}Z`;
}

function claimOf(item: IssueComment, cfg: Config): Claim | undefined {
  const body = item.body ?? "";
  if (pipelineRole(cfg, item) !== "claim") {
    return undefined;
  }
  const { role } = PIPELINE_MARK.exec(body)?.groups ?? {};
  const { lane, sweep } = CLAIM_MARK.exec(body)?.groups ?? {};
  if (role !== "claim" || lane === undefined || sweep === undefined) {
    return undefined;
  }
  return { body, id: item.id, lane, sweep };
}

// The live claims on an issue, earliest first. A claim is a comment the
// pipeline posted as role `claim`. The claim marker alone isn't enough: a
// quoted marker alone cannot establish claim authority.
function liveClaims(cfg: Config, comments: readonly IssueComment[]): Claim[] {
  const maxAge = cfg.leaseHours * MS_PER_HOUR;
  const now = Date.now();
  return comments
    .filter((item) => {
      const edited = Date.parse(item.updated_at ?? item.created_at);
      return now - edited < maxAge;
    })
    .flatMap((item) => claimOf(item, cfg) ?? [])
    .sort((a, b) => a.id - b.id); // comment ids increase with creation
}

function closeClaim(
  cfg: Config,
  claim: Claim,
  note: string,
  options: { allowFail?: boolean } = QUIET,
): void {
  const closed = `<!-- agent-pipeline:claim-closed lane=${claim.lane} sweep=${claim.sweep} -->`;
  editComment(
    cfg,
    claim.id,
    `${claim.body.replace(CLAIM_MARK, closed)}\n\n${note}`,
    options,
  );
}

// Keeps this lane's claim live for another leaseHours.
function touchClaim(cfg: Config, n: number, req: LaneRequest): void {
  const lane = laneOf(req);
  const mine = liveClaims(cfg, listComments(cfg, n)).find(
    (claim) => claim.lane === lane,
  );
  if (mine === undefined) {
    return;
  }
  const stamp = `<sub>Lane still working at ${minuteStamp()}.</sub>`;
  let body = `${mine.body}\n${stamp}`;
  if (STILL_WORKING_AT_END.test(mine.body)) {
    body = mine.body.replace(STILL_WORKING, stamp);
  }
  editComment(cfg, mine.id, body, QUIET);
}

// The issue is leaving the pipeline, so every live claim on it is void.
function closeClaims(cfg: Config, n: number, why: string): void {
  const note = `Closed ${minuteStamp()}: ${why}`;
  for (const claim of liveClaims(cfg, listComments(cfg, n))) {
    closeClaim(cfg, claim, note, {});
  }
}

// Posts this lane's claim and returns the comment GitHub made of it.
function postClaim(cfg: Config, n: number, req: LaneRequest): Claim {
  const lane = laneOf(req);
  const sweep = String(req.sweepId);
  const text = `Lane \`${lane}\` is claiming this issue. If another lane claimed it first, this lane abandons it and takes another issue.`;
  const body = `${signed({ role: "claim", run: sweep }, text)}\n<!-- agent-pipeline:claim lane=${lane} sweep=${sweep} -->`;
  const posted = COMMENT.parse(
    ghJson(cfg, "merge", [
      "api",
      "-X",
      "POST",
      `repos/${cfg.repo}/issues/${n}/comments`,
      "-f",
      `body=${body}`,
    ]),
  );
  return { body: posted.body ?? body, id: posted.id, lane, sweep };
}

// Returns { won } and, when another lane holds the issue, { holder, posted }.
function raceForClaim(
  cfg: Config,
  n: number,
  req: LaneRequest,
  comments: readonly IssueComment[],
): ClaimRace {
  const lane = laneOf(req);
  const [held] = liveClaims(cfg, comments);
  // This lane already holds the issue from an earlier sweep.
  if (held?.lane === lane) {
    return { won: true, claimId: held.id, posted: false };
  }
  // Another lane holds it; claiming would only add a comment that loses.
  if (held !== undefined) {
    return { won: false, holder: held.lane, posted: false };
  }
  const mine = postClaim(cfg, n, req);
  setLabels(cfg, n, [LABELS.working.name]);
  const [first] = liveClaims(cfg, listComments(cfg, n));
  if (first?.id === mine.id) {
    return { won: true, claimId: mine.id, posted: true };
  }
  // An earlier claim won, or this lane can't see its own claim yet; either
  // way, back off.
  const holder = first?.lane ?? null;
  let why = "this lane couldn't confirm its claim was first";
  if (holder !== null) {
    why = `lane \`${holder}\` claimed this issue first`;
  }
  closeClaim(
    cfg,
    mine,
    `Abandoned ${minuteStamp()}: ${why}. This lane takes another issue.`,
  );
  return { won: false, holder, posted: true };
}

export type { Claim, ClaimRace, LaneRequest };
export {
  closeClaim,
  closeClaims,
  laneOf,
  leaseLane,
  liveClaims,
  raceForClaim,
  touchClaim,
};
