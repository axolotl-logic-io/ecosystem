// An issue's machine state: one hidden comment per issue that only the
// pipeline's account writes. Where a start or restart picks up from is
// start-state.ts.

import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import { listComments, rawComment, STATE_MARK } from "./comments.ts";
import type { Config } from "./config.ts";
import { gh } from "./github.ts";
import { OpsError } from "./process.ts";
import { STACKED_ON } from "./stack.ts";

const MARK_END = "-->";
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
// Leaves room under GitHub's comment limit for the header and footer.
const MAX_STATE_LENGTH = 60_000;

const CHECKPOINTS = z.record(
  z.string(),
  z.union([z.number(), z.string(), z.null()]),
);

// The fields the ops modules read; the workflow owns the rest, which pass
// through unchanged.
const STATE = z.looseObject({
  depth: z.number().optional(),
  log: z.array(z.unknown()).nullish(),
  specWritesTests: z.boolean().optional().catch(undefined),
  findings: z.array(z.looseObject({ status: z.unknown() })).nullish(),
  headSha: z.string().nullish(),
  implemented: z.unknown().optional(),
  pr: z.unknown().optional(),
  reviewedSha: z.unknown().optional(),
  // The prerequisite this issue's branch is stacked on (#268); null or
  // missing when it isn't stacked, and null when it is unreadable.
  stackedOn: STACKED_ON.nullish().catch(null),
  stage: z.string().optional(),
  // The code of the stop the state is saved at, as stop.ts saves it; null
  // or missing for none, and null when it is malformed.
  stopCode: z.string().nullish().catch(null),
  // The tokens the issue's sessions have spent (launch-results.ts); a
  // malformed count reads as missing.
  reportedTokens: z.number().optional().catch(undefined),
  // The stage a stop saved at `stopped` stopped in, which a restart resumes
  // at (`every-role-resumes`); null or missing for none, and null when it is
  // malformed.
  stoppedStage: z.string().nullish().catch(null),
  // The values a role's run saved because a later start needs them and
  // GitHub and git can't give them back, such as the counts that bound its
  // loops (#301). A malformed record reads as missing.
  checkpoints: CHECKPOINTS.optional().catch(undefined),
});

type State = z.infer<typeof STATE>;

interface StoredState {
  id: number | null;
  state: State | null;
}

// The state in a state comment's body, or null when it has none or it is
// unreadable.
function parseStateBody(body: string): State | null {
  const start = body.indexOf(STATE_MARK);
  const end = body.indexOf(MARK_END, start);
  if (start < 0 || end < 0) {
    return null;
  }
  try {
    const parsed = STATE.safeParse(
      JSON.parse(body.slice(start + STATE_MARK.length, end)),
    );
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

function readState(
  cfg: Config,
  number: number,
  comments?: readonly IssueComment[],
): StoredState {
  // Only trust a state comment written by the pipeline's account. Anyone can
  // paste the marker.
  const mine = (comments ?? listComments(cfg, number)).filter(
    (item) =>
      item.user?.login === cfg.account &&
      (item.body ?? "").includes(STATE_MARK),
  );
  const latest = mine.at(-1);
  if (latest === undefined) {
    return { id: null, state: null };
  }
  return { id: latest.id, state: parseStateBody(latest.body ?? "") };
}

function writeState(cfg: Config, number: number, state: unknown): void {
  const json = JSON.stringify(state).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  const body = `**🤖 issue-pipeline · state**\n${STATE_MARK}\n${json}\n-->\n<sub>Machine state for #${number}. The pipeline rewrites this comment; do not edit it.</sub>`;
  if (body.length > MAX_STATE_LENGTH) {
    throw new OpsError(
      `state for #${number} is too large (${body.length} chars)`,
    );
  }
  const { id } = readState(cfg, number);
  if (id === null) {
    rawComment(cfg, number, body);
    return;
  }
  gh(cfg, [
    "api",
    "-X",
    "PATCH",
    `repos/${cfg.repo}/issues/comments/${id}`,
    "-f",
    `body=${body}`,
    "--silent",
  ]);
}

function newState(number: number, depth: number): State {
  return {
    version: 1,
    number,
    depth,
    stage: "triage",
    lease: null,
    pr: null,
    headSha: null,
    reviewedSha: null,
    verifiedSha: null,
    plan: null,
    reportedTokens: 0,
    triages: 0,
    continuations: {},
    round: 0,
    ciFixes: 0,
    syncs: 0,
    findings: [],
    resolvedHistory: [],
    questionsAt: null,
    stackedOn: null,
    log: [],
  };
}

export type { State, StoredState };
export { newState, parseStateBody, readState, STATE, writeState };
