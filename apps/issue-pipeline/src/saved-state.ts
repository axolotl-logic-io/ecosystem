// An issue's saved state on GitHub: one hidden comment per issue that only
// the pipeline's account writes. GitHub is the source of truth; anyone can
// paste the marker, so only the account's own comments are read. A state the
// installed version saved (version 1) reads as version 2.

import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import {
  isStateBody,
  listComments,
  rawComment,
  STATE_HEADER,
  STATE_MARK,
} from "./comments.ts";
import type { Config } from "./config.ts";
import { gh } from "./github.ts";
import { OpsError } from "./process.ts";
import type { Stage } from "./stages.ts";
import type { IssueState } from "./state.ts";
import {
  clippedLog,
  FLOWS,
  ISSUE_STATE,
  LEASE,
  newIssueState,
  withLog,
} from "./state.ts";

// Mutation authority is deliberately stricter than the compatibility reader:
// a missing receipt must not be confused with a malformed one caught as null.
const WRITE_STATE = ISSUE_STATE.pick({
  version: true,
  number: true,
  stage: true,
}).extend({
  stoppedStage: ISSUE_STATE.shape.stoppedStage.removeCatch(),
  stopCode: ISSUE_STATE.shape.stopCode.removeCatch(),
  branch: ISSUE_STATE.shape.branch.removeCatch(),
  pr: ISSUE_STATE.shape.pr.removeCatch(),
  codeMerged: ISSUE_STATE.shape.codeMerged.removeCatch(),
  merged: ISSUE_STATE.shape.merged.removeCatch(),
  hardened: ISSUE_STATE.shape.hardened.removeCatch(),
  integration: ISSUE_STATE.shape.integration.removeCatch(),
  security: ISSUE_STATE.shape.security.removeCatch(),
  gherkin: ISSUE_STATE.shape.gherkin.removeCatch(),
});

const MARK_END = "-->";
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
// Leaves room under GitHub's comment limit for the header and footer.
const MAX_STATE_LENGTH = 60_000;

// The installed version's (version 1) fields the migration reads; it drops
// every other field.
const LEGACY_STATE = z.looseObject({
  stage: z.string().optional().catch(undefined),
  stoppedStage: z.string().nullish().catch(null),
  stopCode: z.string().nullish().catch(null),
  lease: LEASE.nullish().catch(null),
  pr: z.number().int().positive().nullish().catch(null),
  headSha: z.string().nullish().catch(null),
  flows: FLOWS.nullish().catch(null),
  log: z.array(z.unknown()).nullish().catch(null),
});

// Legacy stages before any code work, which go to the author alone.
const LEGACY_AUTHOR_STAGES: ReadonlySet<string> = new Set(["triage", "spec"]);

interface StoredState {
  id: number | null;
  state: IssueState | null;
}

// Where a legacy stage resumes after the author writes the Gherkin: null for
// the stages before code work; review for a merged issue whose wiki is
// unpublished (the reviewer sees the wiki before it is published); implement
// for every other stage, so the job verifies the branch afresh.
function legacyResumeStage(
  stage: string | undefined,
): Extract<Stage, "review" | "implement"> | null {
  if (stage === undefined || LEGACY_AUTHOR_STAGES.has(stage)) {
    return null;
  }
  if (stage === "publish") {
    return "review";
  }
  return "implement";
}

// A version 1 state read as version 2. Every legacy issue goes to the author
// first, since no Gherkin exists yet; it keeps its PR, head, lease and flows.
function migrateLegacyState(raw: unknown, number: number): IssueState {
  const legacy = LEGACY_STATE.safeParse(raw).data ?? {};
  const base = newIssueState(number);
  const kept: IssueState = {
    ...base,
    lease: legacy.lease ?? null,
    pr: legacy.pr ?? null,
    headSha: legacy.headSha ?? null,
    flows: legacy.flows ?? null,
    log: clippedLog(
      (legacy.log ?? []).filter((entry) => typeof entry === "string"),
    ),
  };
  const { stage } = legacy;
  if (stage === "done") {
    return { ...kept, stage: "done" };
  }
  if (stage === "stopped") {
    return {
      ...kept,
      stage: "stopped",
      stoppedStage: "author",
      stopCode: legacy.stopCode ?? null,
      resumeStage: legacyResumeStage(legacy.stoppedStage ?? undefined),
    };
  }
  return { ...kept, resumeStage: legacyResumeStage(stage) };
}

// The saved state in `raw`: version 2 as saved, an older version migrated,
// or null when it can't be read.
function parseIssueState(raw: unknown, number: number): IssueState | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  if ("version" in raw && raw.version === 2) {
    return ISSUE_STATE.safeParse(raw).data ?? null;
  }
  const migrated = migrateLegacyState(raw, number);
  const legacy = LEGACY_STATE.safeParse(raw).data;
  return withLog(
    migrated,
    `migrated from the installed version's state at ${legacy?.stage ?? "no stage"}`,
    new Date(),
  );
}

// The state in a state comment's body, or null when it has none or it is
// unreadable.
function parseStateBody(body: string, number: number): IssueState | null {
  try {
    return parseIssueState(rawStateBody(body), number);
  } catch {
    return null;
  }
}

function rawStateBody(body: string): unknown {
  const start = body.indexOf(STATE_MARK);
  const end = body.indexOf(MARK_END, start);
  if (start < 0 || end < 0) {
    throw new OpsError("saved write authority is unreadable");
  }
  return JSON.parse(body.slice(start + STATE_MARK.length, end));
}

function latestStateComment(
  cfg: Config,
  comments: readonly IssueComment[],
): IssueComment | undefined {
  return comments
    .filter(
      (item) =>
        item.user?.login === cfg.account && isStateBody(item.body ?? ""),
    )
    .at(-1);
}

// Fresh saved mutation authority, never a request's state. Legacy state must
// first pass through claim migration/save. Invalid critical fields throw;
// display/migration readers retain readState's tolerant behavior.
function readWriteState(cfg: Config, number: number): IssueState {
  const latest = latestStateComment(cfg, listComments(cfg, number));
  if (latest === undefined) {
    throw new OpsError(`#${number} has no saved write authority`);
  }
  const raw = rawStateBody(latest.body ?? "");
  const critical = WRITE_STATE.safeParse(raw);
  if (!critical.success || critical.data.number !== number) {
    throw new OpsError(`#${number}'s saved write authority is invalid`);
  }
  return ISSUE_STATE.parse(raw);
}

function readState(
  cfg: Config,
  number: number,
  comments?: readonly IssueComment[],
): StoredState {
  // Only trust a state comment written by the pipeline's account. Anyone can
  // paste the marker.
  const latest = latestStateComment(cfg, comments ?? listComments(cfg, number));
  if (latest === undefined) {
    return { id: null, state: null };
  }
  return { id: latest.id, state: parseStateBody(latest.body ?? "", number) };
}

function stateBody(number: number, state: IssueState): string {
  const json = JSON.stringify(ISSUE_STATE.parse(state)).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  return `${STATE_HEADER}\n${STATE_MARK}\n${json}\n-->\n<sub>Machine state for #${number}. The pipeline rewrites this comment; do not edit it.</sub>`;
}

function writeState(cfg: Config, number: number, state: IssueState): void {
  const body = stateBody(number, state);
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

export type { StoredState };
export {
  migrateLegacyState,
  parseIssueState,
  parseStateBody,
  readState,
  readWriteState,
  stateBody,
  writeState,
};
