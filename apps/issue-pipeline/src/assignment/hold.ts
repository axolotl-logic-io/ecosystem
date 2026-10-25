// A durable hold on an assigned issue (#174): what a job started for an
// assignment records on GitHub when it ends blocked, so no later sweep, and
// no sweep after a restart, starts the same work again until something
// changes. The record is one keyed comment from the landing account, edited
// in place, and read back only with landing authorship and editor provenance
// (comment-authority.ts), so no one else can write or lift a hold.
//
//   { version: 1, work, end, reason, at, retryAt, count, condition }
//
// `work` is the stage or task that held. `condition` is what the hold waits
// on: the latest event and comment by anyone but the pipeline's accounts,
// the issue branch's head and the target's head. A person's comment, label
// or assignment, a pushed branch or a moved target changes it. A deferral
// (`end` deferred) also lifts at `retryAt`, which doubles with each
// deferral of the same work on the same condition, from 1 minute to 1 hour.
// A hold of other work never applies, so progress is never held back.

import { z } from "zod";
import { assertCommentAuthority } from "../comment-authority.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { git } from "../github.ts";
import { listing } from "./grant.ts";

const HOLD_MARK = "<!-- issue-pipeline:assignment-hold\n";
const HOLD_KEY = "assignment-hold";
const FIRST_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const WHITESPACE = /\s+/u;

const CONDITION = z.object({
  event: z.number().nullable(),
  comment: z.number().nullable(),
  branch: z.string().nullable(),
  target: z.string().nullable(),
});
const HOLD = z.object({
  version: z.literal(1),
  work: z.string(),
  end: z.enum(["wait", "deferred"]),
  reason: z.string(),
  at: z.string(),
  retryAt: z.string().nullable(),
  count: z.number().int().positive(),
  condition: CONDITION,
});
const ROW = z.looseObject({
  id: z.number(),
  actor: z.looseObject({ login: z.string() }).nullish(),
  user: z.looseObject({ login: z.string() }).nullish(),
});

type Condition = z.infer<typeof CONDITION>;
type HoldRecord = z.infer<typeof HOLD>;

function pipelineAccount(cfg: Config, login: string | undefined): boolean {
  return [cfg.devAccount, cfg.mergeAccount].some(
    (account) => account.toLowerCase() === (login ?? "").toLowerCase(),
  );
}

// The latest id among `rows` that someone other than the pipeline made.
function latestOther(
  cfg: Config,
  rows: readonly z.infer<typeof ROW>[],
): number | null {
  const ids = rows
    .filter((row) => !pipelineAccount(cfg, (row.actor ?? row.user)?.login))
    .map((row) => row.id);
  if (ids.length === 0) {
    return null;
  }
  return Math.max(...ids);
}

// The heads of `branches` on the remote, by branch, or null when unreadable.
function headsOf(
  cfg: Config,
  branches: readonly string[],
): Map<string, string> | null {
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  const refs = branches.map((branch) => `refs/heads/${branch}`);
  const listed = git(cfg, "dev", ["ls-remote", url, ...refs], {
    allowFail: true,
  });
  if (listed.code !== 0) {
    return null;
  }
  const heads = new Map<string, string>();
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const [sha = "", ref = ""] = line.split(WHITESPACE);
    heads.set(ref.slice("refs/heads/".length), sha);
  }
  return heads;
}

// What an issue's hold waits on now, read fresh, or null when it can't be
// read in full: unknown never lifts a hold.
function conditionOf(
  cfg: Config,
  issue: number,
  branch: string,
): Condition | null {
  const base = `repos/${cfg.repo}/issues/${issue}`;
  const events = listing(cfg, `${base}/events?per_page=100`, ROW);
  const comments = listing(cfg, `${base}/comments?per_page=100`, ROW);
  const heads = headsOf(cfg, [branch, cfg.baseBranch]);
  if (events === null || comments === null || heads === null) {
    return null;
  }
  return {
    event: latestOther(cfg, events),
    comment: latestOther(cfg, comments),
    branch: heads.get(branch) ?? null,
    target: heads.get(cfg.baseBranch) ?? null,
  };
}

function sameCondition(a: Condition, b: Condition): boolean {
  return (
    a.event === b.event &&
    a.comment === b.comment &&
    a.branch === b.branch &&
    a.target === b.target
  );
}

// The issue's hold record, the landing account's latest; a record whose
// provenance doesn't check throws, as any authority record's does.
function holdOf(
  cfg: Config,
  comments: readonly IssueComment[],
): HoldRecord | null {
  const latest = comments
    .filter(
      (item) =>
        item.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase() &&
        (item.body ?? "").includes(HOLD_MARK),
    )
    .at(-1);
  if (latest === undefined) {
    return null;
  }
  assertCommentAuthority(cfg, latest);
  const body = latest.body ?? "";
  const start = body.indexOf(HOLD_MARK) + HOLD_MARK.length;
  const parsed = HOLD.safeParse(
    JSON.parse(body.slice(start, body.indexOf("\n-->", start))),
  );
  if (!parsed.success) {
    throw new Error(`hold record ${latest.id} doesn't parse`);
  }
  return parsed.data;
}

// Why `record` still holds `work` at `now`, given what the hold waits on
// now, or null when it doesn't apply.
function holdReason(
  record: HoldRecord | null,
  work: string,
  current: Condition | null,
  now: Date,
): string | null {
  if (record === null || record.work !== work) {
    return null;
  }
  if (current === null) {
    return `held: ${record.reason}; what it waits on couldn't be read`;
  }
  if (!sameCondition(record.condition, current)) {
    return null;
  }
  if (record.retryAt !== null && now.getTime() >= Date.parse(record.retryAt)) {
    return null;
  }
  let until = "until something changes";
  if (record.retryAt !== null) {
    until = `until ${record.retryAt}`;
  }
  return `held since ${record.at}: ${record.reason} (${until})`;
}

// The record a blocked end of `work` makes, after `previous`.
function nextHold(
  previous: HoldRecord | null,
  blocked: {
    work: string;
    end: "wait" | "deferred";
    reason: string;
    condition: Condition;
  },
  now: Date,
): HoldRecord {
  let count = 1;
  if (
    previous !== null &&
    previous.work === blocked.work &&
    previous.end === blocked.end &&
    sameCondition(previous.condition, blocked.condition)
  ) {
    count = previous.count + 1;
  }
  let retryAt: string | null = null;
  if (blocked.end === "deferred") {
    const seconds = Math.min(
      FIRST_RETRY_SECONDS * 2 ** (count - 1),
      MAX_RETRY_SECONDS,
    );
    retryAt = new Date(now.getTime() + seconds * MS_PER_SECOND).toISOString();
  }
  return { version: 1, ...blocked, at: now.toISOString(), retryAt, count };
}

function holdBody(record: HoldRecord): string {
  return [
    `**Held for the assignment sweep:** ${record.reason}`,
    "",
    "The sweep starts this work again once a person comments, labels or reassigns, the branch or the target moves, or the retry time passes.",
    `${HOLD_MARK}${JSON.stringify(record)}\n-->`,
  ].join("\n");
}

// The branch an assigned issue works on: its saved one, or the default.
function branchOf(issue: number, saved: string | null | undefined): string {
  return saved ?? paths.legacyBranch(issue);
}

export type { Condition, HoldRecord };
export {
  branchOf,
  conditionOf,
  HOLD_KEY,
  holdBody,
  holdOf,
  holdReason,
  nextHold,
};
