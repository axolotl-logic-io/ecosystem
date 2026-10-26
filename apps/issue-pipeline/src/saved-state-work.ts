// A work item's saved state, version 4: the runtime's durable action
// checkpoint, in the item's one state comment that only the landing account
// writes. It holds local observations, never permission: no stage cursor,
// approval, clearance or Land intent. Task readiness comes from the
// authenticated task records (src/tasks/records.ts), and a Land's durable
// intent is its own v2 attempt record. The lease is an observation of
// liveness only. Any other version holds the item: it is never adopted or
// overwritten.

import { z } from "zod";
import { assertCommentAuthority } from "./comment-authority.ts";
import { isStateBody, STATE_HEADER, STATE_MARK } from "./comment-marks.ts";
import type { IssueComment } from "./comments.ts";
import { listComments, rawComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { gh, redactGhArgs } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import { redactLocalPaths } from "./pipeline-root.ts";
import { redactAddresses } from "./redact-addresses.ts";

const WORK_STATE_VERSION = 4;
const MAX_LOG_ENTRIES = 40;
const MAX_LOG_ENTRY = 300;
const STAMP_LENGTH = 16;
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
// Leaves room under GitHub's comment limit for the header and footer.
const MAX_STATE_LENGTH = 60_000;
const MARK_END = "-->";

const LEASE = z.strictObject({
  lane: z.string().min(1),
  at: z.iso.datetime(),
});

const WORK_STATE = z.strictObject({
  version: z.literal(WORK_STATE_VERSION),
  number: z.number().int().positive(),
  // The action run whose checkpoint wrote it: an observation, not authority.
  action: z.uuid().nullable(),
  lease: LEASE.nullable(),
  // The branch the runtime assigned the item, and its PR once it has one.
  branch: z.string().min(1).nullable(),
  pr: z.number().int().positive().nullable(),
  // The last code head an action pushed.
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  // The action's latest progress, with private diagnostics redacted.
  checkpoint: z.json().nullable(),
  log: z.array(z.string().max(MAX_LOG_ENTRY)).max(MAX_LOG_ENTRIES),
});
const VERSIONED = z.looseObject({ version: z.unknown(), number: z.unknown() });

type WorkState = z.infer<typeof WORK_STATE>;

// The item's saved state as read: none, or version 4.
type StoredWork =
  | { kind: "none" }
  | { kind: "current"; id: number; state: WorkState };

function newWorkState(number: number): WorkState {
  return {
    version: WORK_STATE_VERSION,
    number,
    action: null,
    lease: null,
    branch: null,
    pr: null,
    headSha: null,
    checkpoint: null,
    log: [],
  };
}

function stamp(now: Date): string {
  return `${now.toISOString().slice(0, STAMP_LENGTH)}Z`;
}

// `state` with `entry` appended to its log, keeping the log short.
function withWorkLog(state: WorkState, entry: string, now: Date): WorkState {
  const log = [...state.log, `${stamp(now)} ${entry}`]
    .slice(-MAX_LOG_ENTRIES)
    .map((item) => item.slice(0, MAX_LOG_ENTRY));
  return { ...state, log };
}

// The landing account's latest state comment in `comments`. A state body
// anyone else wrote has no authority and throws, rather than reading as no
// state.
function latestStateComment(
  cfg: Pick<Config, "landingAccount">,
  comments: readonly IssueComment[],
): IssueComment | undefined {
  const landing = cfg.landingAccount.toLowerCase();
  const own = comments.filter(
    (item) => item.user?.login.toLowerCase() === landing,
  );
  for (const item of own) {
    assertCommentAuthority(cfg, item);
  }
  const latest = own.filter((item) => isStateBody(item.body ?? "")).at(-1);
  if (
    latest === undefined &&
    comments.some((item) => isStateBody(item.body ?? ""))
  ) {
    throw new OpsError(
      "saved pipeline state has no landing authority; stop for reconciliation",
    );
  }
  return latest;
}

function rawStateBody(body: string): unknown {
  const start = body.indexOf(STATE_MARK);
  const end = body.indexOf(MARK_END, start);
  if (start < 0 || end < 0) {
    throw new OpsError("saved work state is unreadable");
  }
  return JSON.parse(body.slice(start + STATE_MARK.length, end));
}

// The item's saved state in `comments`. A state of another version, one that
// doesn't parse, or one that names another item throws: it holds the item.
function storedWork(
  cfg: Pick<Config, "landingAccount">,
  number: number,
  comments: readonly IssueComment[],
): StoredWork {
  const latest = latestStateComment(cfg, comments);
  if (latest === undefined) {
    return { kind: "none" };
  }
  const raw = rawStateBody(latest.body ?? "");
  const { version } = VERSIONED.parse(raw);
  if (version !== WORK_STATE_VERSION) {
    throw new OpsError(
      `#${number} has version ${String(version)} saved state, which is never adopted; reconcile it explicitly`,
    );
  }
  const parsed = WORK_STATE.safeParse(raw);
  if (!parsed.success || parsed.data.number !== number) {
    throw new OpsError(`#${number}'s saved work state is invalid`);
  }
  return { kind: "current", id: latest.id, state: parsed.data };
}

function readWorkState(cfg: Config, number: number): StoredWork {
  return storedWork(cfg, number, listComments(cfg, number));
}

function workStateBody(state: WorkState): string {
  const json = JSON.stringify(WORK_STATE.parse(state)).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  return `${STATE_HEADER}\n${STATE_MARK}\n${json}\n-->\n<sub>Machine state for #${state.number}. The pipeline rewrites this comment; do not edit it.</sub>`;
}

// Reads the state back: a write it can't confirm is uncertain, and the
// next writer reconciles it by reading, never by assuming.
function confirmWritten(cfg: Config, state: WorkState): void {
  const stored = readWorkState(cfg, state.number);
  if (
    stored.kind !== "current" ||
    JSON.stringify(stored.state) !== JSON.stringify(WORK_STATE.parse(state))
  ) {
    throw new OpsError(
      `#${state.number}'s saved work state is uncertain; reconcile by reading`,
    );
  }
}

// Redact diagnostic values, never object keys. If a key itself needs
// redaction, the full-body invariant below refuses before a write rather
// than merging distinct keys or changing the checkpoint's structure.
function publicCheckpoint(
  value: WorkState["checkpoint"],
): WorkState["checkpoint"] {
  if (typeof value === "string") {
    return redactAddresses(redactLocalPaths(value));
  }
  if (Array.isArray(value)) {
    return value.map(publicCheckpoint);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, publicCheckpoint(item)]),
    );
  }
  return value;
}

// Checkpoints and logs are observations, not authority. Normalize those
// diagnostics before posting so confirmation compares the actual public
// representation. The action, item, branch and other identity fields must
// survive the transport unchanged.
function publicWorkState(state: WorkState): WorkState {
  const input = WORK_STATE.parse(state);
  const expected = WORK_STATE.parse({
    ...input,
    checkpoint: publicCheckpoint(input.checkpoint),
    log: input.log.map((entry) =>
      redactAddresses(redactLocalPaths(entry)).slice(0, MAX_LOG_ENTRY),
    ),
  });
  const field = `body=${workStateBody(expected)}`;
  if (redactGhArgs([field])[0] !== field) {
    throw new OpsError(
      "saved work state would change identity fields during redaction",
    );
  }
  return expected;
}

// Writes `state` as the item's version 4 state: a new state comment when it
// has none, else an edit of its version 4 comment, then confirms it by a
// fresh read. A state of another version is never overwritten or adopted.
function writeWorkState(cfg: Config, state: WorkState): void {
  const expected = publicWorkState(state);
  const body = workStateBody(expected);
  if (body.length > MAX_STATE_LENGTH) {
    throw new OpsError(
      `state for #${state.number} is too large (${body.length} chars)`,
    );
  }
  const stored = readWorkState(cfg, state.number);
  if (stored.kind === "none") {
    rawComment(cfg, state.number, body, true);
    confirmWritten(cfg, expected);
    return;
  }
  gh(
    cfg,
    "landing",
    [
      "api",
      "-X",
      "PATCH",
      `repos/${cfg.repo}/issues/comments/${stored.id}`,
      "-f",
      `body=${body}`,
      "--silent",
    ],
    { reconciles: true },
  );
  confirmWritten(cfg, expected);
}

export type { StoredWork, WorkState };
export {
  newWorkState,
  readWorkState,
  storedWork,
  WORK_STATE,
  WORK_STATE_VERSION,
  withWorkLog,
  writeWorkState,
};
