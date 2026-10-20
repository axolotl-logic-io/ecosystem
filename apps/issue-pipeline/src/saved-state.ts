// An issue's saved state on GitHub: one hidden comment per issue that only
// merge identity writes. GitHub is the source of truth; current merge-bot
// authorship and editor provenance are required for authority. Version 1 is
// display-only: claims refuse it until explicit reconciliation.

import { assertCommentAuthority } from "./comment-authority.ts";
import {
  isLegacyPipelineComment,
  isStateBody,
  STATE_HEADER,
  STATE_MARK,
} from "./comment-marks.ts";
import type { IssueComment } from "./comments.ts";
import { listComments, rawComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { gh } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import { LEGACY_STATE, migrateLegacyState } from "./saved-state-legacy.ts";
import type { IssueState } from "./state.ts";
import { ISSUE_STATE, withLog } from "./state.ts";

// Mutation authority is deliberately stricter than the compatibility reader:
// a missing receipt must not be confused with a malformed one caught as null.
const WRITE_STATE = ISSUE_STATE.pick({
  version: true,
  coordination: true,
  number: true,
  stage: true,
}).extend({
  stoppedStage: ISSUE_STATE.shape.stoppedStage.removeCatch(),
  stopCode: ISSUE_STATE.shape.stopCode.removeCatch(),
  branch: ISSUE_STATE.shape.branch.removeCatch(),
  headSha: ISSUE_STATE.shape.headSha.removeCatch(),
  flows: ISSUE_STATE.shape.flows.removeCatch(),
  lease: ISSUE_STATE.shape.lease.removeCatch(),
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

interface StoredState {
  id: number | null;
  state: IssueState | null;
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
  for (const item of comments) {
    if (item.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase()) {
      assertCommentAuthority(cfg, item);
    }
  }
  const latest = comments
    .filter(
      (item) =>
        item.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase() &&
        isStateBody(item.body ?? ""),
    )
    .at(-1);
  if (
    latest === undefined &&
    comments.some(
      (item) =>
        isLegacyPipelineComment(cfg, item) && isStateBody(item.body ?? ""),
    )
  ) {
    throw new OpsError("legacy pipeline state needs explicit reconciliation");
  }
  if (
    latest === undefined &&
    comments.some((item) => isStateBody(item.body ?? ""))
  ) {
    throw new OpsError(
      "saved pipeline state has no merge authority; stop for reconciliation",
    );
  }
  return latest;
}

// Fresh saved mutation authority, never a request's state. Legacy state
// cannot authorize mutation. Invalid critical fields throw;
// display/migration readers retain readState's tolerant behavior.
function readWriteState(cfg: Config, number: number): IssueState {
  const latest = latestStateComment(cfg, listComments(cfg, number));
  if (latest === undefined) {
    throw new OpsError(`#${number} has no saved write authority`);
  }
  const raw = rawStateBody(latest.body ?? "");
  return validatedWriteState(raw, number);
}

function validatedWriteState(raw: unknown, number: number): IssueState {
  const critical = WRITE_STATE.safeParse(raw);
  if (!critical.success || critical.data.number !== number) {
    throw new OpsError(`#${number}'s saved write authority is invalid`);
  }
  return ISSUE_STATE.parse(raw);
}

// Claim may initialize genuinely absent state, never adopt legacy state.
// Every existing v2 state uses the same strict validator as credentialed writes.
function readClaimState(
  cfg: Config,
  number: number,
  comments: readonly IssueComment[],
): IssueState | null {
  const latest = latestStateComment(cfg, comments);
  if (latest === undefined) {
    return null;
  }
  const raw = rawStateBody(latest.body ?? "");
  if (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    raw.version === 1
  ) {
    throw new OpsError("legacy pipeline state needs explicit reconciliation");
  }
  return validatedWriteState(raw, number);
}

function readState(
  cfg: Config,
  number: number,
  comments?: readonly IssueComment[],
): StoredState {
  // Provenance is checked before compatibility parsing.
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
  gh(cfg, "merge", [
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
  parseIssueState,
  parseStateBody,
  readClaimState,
  readState,
  readWriteState,
  stateBody,
  writeState,
};
