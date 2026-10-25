// A work item's saved state, version 4: the runtime's durable action
// checkpoint, in the item's one state comment that only the landing account
// writes. It holds local observations, never permission: no stage cursor,
// approval, clearance or Land intent. Task readiness comes from the
// authenticated task records (src/tasks/records.ts), and a Land's durable
// intent is its own v2 attempt record. The lease is an observation of
// liveness only.
//
// Versions 1 to 3 (state.ts, saved-state.ts) are history. This reader
// returns them as historical, never adopted, and the writer refuses to
// overwrite them: their bytes stay where they are for the fences and
// explanations that read them.

import { z } from "zod";
import { STATE_HEADER, STATE_MARK } from "./comment-marks.ts";
import type { IssueComment } from "./comments.ts";
import { listComments, rawComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { gh } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import { latestStateComment, rawStateBody } from "./saved-state.ts";

const WORK_STATE_VERSION = 4;
const MAX_LOG_ENTRIES = 40;
const MAX_LOG_ENTRY = 300;
const STAMP_LENGTH = 16;
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
// Leaves room under GitHub's comment limit for the header and footer.
const MAX_STATE_LENGTH = 60_000;

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
  // The latest progress the action checkpointed, as it gave it.
  checkpoint: z.json().nullable(),
  log: z.array(z.string().max(MAX_LOG_ENTRY)).max(MAX_LOG_ENTRIES),
});
const VERSIONED = z.looseObject({ version: z.unknown(), number: z.unknown() });

type WorkState = z.infer<typeof WORK_STATE>;

// The item's saved state as read: none, version 4, or a historical version
// whose bytes are kept but never adopted.
type StoredWork =
  | { kind: "none" }
  | { kind: "current"; id: number; state: WorkState }
  | { kind: "historical"; id: number; version: unknown; raw: unknown };

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

// The item's saved state in `comments`. A version 4 state that doesn't
// parse, or names another item, throws: it holds the item.
function storedWork(
  cfg: Pick<Config, "landingAccount" | "legacyAccount">,
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
    return { kind: "historical", id: latest.id, version, raw };
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

// Writes `state` as the item's version 4 state: a new state comment when it
// has none, else an edit of its version 4 comment, then confirms it by a
// fresh read. A historical state is never overwritten or adopted.
function writeWorkState(cfg: Config, state: WorkState): void {
  const body = workStateBody(state);
  if (body.length > MAX_STATE_LENGTH) {
    throw new OpsError(
      `state for #${state.number} is too large (${body.length} chars)`,
    );
  }
  const stored = readWorkState(cfg, state.number);
  if (stored.kind === "historical") {
    throw new OpsError(
      `#${state.number} has historical version ${String(stored.version)} state, which is never adopted; reconcile it explicitly`,
    );
  }
  if (stored.kind === "none") {
    rawComment(cfg, state.number, body, true);
    confirmWritten(cfg, state);
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
  confirmWritten(cfg, state);
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
