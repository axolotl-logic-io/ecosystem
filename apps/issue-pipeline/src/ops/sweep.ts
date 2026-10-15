// The sweep op: reads the repo's open issues and returns, in order, the few
// this lane may claim, and the split parents it reserved to close. Several
// lanes of one repo can run at once, on one machine or several, so each sweep
// works on one issue; the workflow claims the candidates one at a time (see
// raceForClaim) until a claim wins.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureClone } from "../checkouts.ts";
import { laneOf, leaseLane } from "../claims.ts";
import type { Config } from "../config.ts";
import { publicConfig } from "../config.ts";
import { gh, ghJson, isAllowedUser } from "../github.ts";
import { ensureLabels, LABELS } from "../labels.ts";
import { RESERVATION_MS, withRepoLock } from "../locks.ts";
import { ROOT } from "../pipeline-root.ts";
import { OpsError } from "../process.ts";
import { readState } from "../state.ts";
import type { Candidate, IssueRow, SweepContext } from "./sweep-verdict.ts";
import {
  classify,
  ISSUE_ROW,
  issueDepth,
  liveLease,
  PRIORITY,
} from "./sweep-verdict.ts";

const MS_PER_HOUR = 3_600_000;
const ISSUE_LIST_LIMIT = 300;
const JSON_INDENT = 2;
const PARENT_KEY = "parent-";

const SWEEP_REQUEST = z.looseObject({
  lane: z.unknown().optional(),
  // The one issue a run was launched for (workflow args.issue).
  only: z.union([z.number(), z.string()]).nullish(),
  sweepId: z.unknown().optional(),
});

// The config keys only the sweep reads; loadConfig applied their defaults.
const SWEEP_SETTINGS = z.looseObject({
  claimCandidates: z.number(),
  skipLabels: z.array(z.string()).nullish(),
  takeNewWork: z.unknown().optional(),
});

// The rows, or null when gh printed nothing.
const ISSUE_ROWS = z.array(ISSUE_ROW).nullable();
const RESERVATION = z.looseObject({
  at: z.string(),
  sweepId: z.unknown().optional(),
});
const RESERVATIONS = z.record(z.string(), z.unknown());

type SweepRequest = z.infer<typeof SWEEP_REQUEST>;

interface SweepReply {
  config: Omit<Config, "tokenFile">;
  items: Candidate[];
  waiting: number;
  parents: number[];
  liveElsewhere: number;
  skipped: number;
}

// Reserves the split parents no other live sweep on this machine reserved, so
// two sweeps don't close the same parent at once, and returns them. Runs
// inside the repo's lock.
function reserveParents(
  cfg: Config,
  sweepId: unknown,
  parents: readonly number[],
  now: number,
): number[] {
  const file = path.join(ROOT, "runs", cfg.slug, "reservations.json");
  let held: Record<string, unknown> = {};
  try {
    held = RESERVATIONS.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // No reservations yet, or an unreadable file: nothing is held.
  }
  const others: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(held)) {
    const reservation = RESERVATION.safeParse(entry).data;
    if (
      key.startsWith(PARENT_KEY) &&
      reservation !== undefined &&
      reservation.sweepId !== sweepId &&
      now - Date.parse(reservation.at) < RESERVATION_MS
    ) {
      others[key] = entry;
    }
  }
  const mine = parents.filter((n) => !(`${PARENT_KEY}${n}` in others));
  const at = new Date(now).toISOString();
  const reserved = Object.fromEntries(
    mine.map((n) => [`${PARENT_KEY}${n}`, { sweepId, at }]),
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ ...others, ...reserved }, null, JSON_INDENT),
  );
  return mine;
}

// A run launched for one named issue takes it even with an agent:stopped-*
// label on it: a human chose it. It still refuses an issue another live lane
// holds, and its claim races like any other.
function sweepOne(
  ctx: SweepContext,
  issues: readonly IssueRow[],
  n: number,
): SweepReply {
  const issue = issues.find((row) => row.number === n);
  if (issue === undefined) {
    throw new OpsError(`#${n} is not an open issue`);
  }
  const author = issue.author?.login;
  if (!isAllowedUser(ctx.cfg, author)) {
    throw new OpsError(
      `#${n} was opened by @${String(author)}, who is not on allowedUsers or not a collaborator`,
    );
  }
  const working = issue.labels.some(
    (label) => label.name === LABELS.working.name,
  );
  const { state } = readState(ctx.cfg, n);
  const lease = liveLease(state, ctx.now, ctx.leaseMs);
  if (working && lease !== null && leaseLane(lease) !== ctx.lane) {
    throw new OpsError(
      `#${n} is held by live lane ${String(leaseLane(lease))}`,
    );
  }
  return {
    config: publicConfig(ctx.cfg),
    items: [
      {
        number: n,
        title: issue.title,
        kind: "named",
        priority: PRIORITY.named,
        createdAt: issue.createdAt,
        depth: issueDepth(issue.body),
      },
    ],
    waiting: 0,
    parents: [],
    liveElsewhere: 0,
    skipped: 0,
  };
}

// The issue a run names, or null for a full sweep.
function namedIssue(only: SweepRequest["only"]): number | null {
  if (only === undefined || only === null || only === "" || only === 0) {
    return null;
  }
  return Number(only);
}

// The open issues, after checking gh acts as the config's account: every
// signature and trust check assumes it does.
function openIssues(cfg: Config): IssueRow[] {
  const login = gh(cfg, ["api", "user", "--jq", ".login"]).stdout.trim();
  if (login !== cfg.account) {
    throw new OpsError(
      `gh is logged in as ${login}, but the config's account is ${cfg.account}`,
    );
  }
  ensureLabels(cfg);
  ensureClone(cfg);
  const listed = ghJson(cfg, [
    "issue",
    "list",
    "-R",
    cfg.repo,
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIST_LIMIT),
    "--json",
    "number,title,author,labels,createdAt,body",
  ]);
  return ISSUE_ROWS.parse(listed) ?? [];
}

function byPriority(a: Candidate, b: Candidate): number {
  return (
    a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
}

interface Tally {
  candidates: Candidate[];
  parents: number[];
  liveElsewhere: number;
  skipped: number;
}

// Judges every open issue and counts the verdicts.
function tally(ctx: SweepContext, issues: readonly IssueRow[]): Tally {
  const counted: Tally = {
    candidates: [],
    parents: [],
    liveElsewhere: 0,
    skipped: 0,
  };
  for (const issue of issues) {
    const verdict = classify(ctx, issue);
    switch (verdict.kind) {
      case "skip":
      case "waiting-on-after":
        break;
      case "skipped":
        counted.skipped += 1;
        break;
      case "parent":
        counted.parents.push(issue.number);
        break;
      case "live-elsewhere":
        counted.liveElsewhere += 1;
        break;
      case "candidate":
        counted.candidates.push(verdict.candidate);
        break;
      default: {
        const unknown: never = verdict;
        throw new OpsError(`unknown verdict ${JSON.stringify(unknown)}`);
      }
    }
  }
  return counted;
}

function sweep(cfg: Config, request: unknown): SweepReply {
  const req = SWEEP_REQUEST.parse(request);
  const settings = SWEEP_SETTINGS.parse(cfg);
  const issues = openIssues(cfg);
  const ctx: SweepContext = {
    cfg,
    lane: laneOf(req),
    skipLabels: settings.skipLabels ?? [],
    takeNewWork: settings.takeNewWork !== false,
    openNumbers: new Set(issues.map((issue) => issue.number)),
    now: Date.now(),
    leaseMs: cfg.leaseHours * MS_PER_HOUR,
  };
  const named = namedIssue(req.only);
  if (named !== null) {
    return sweepOne(ctx, issues, named);
  }
  const { candidates, parents, liveElsewhere, skipped } = tally(ctx, issues);
  candidates.sort(byPriority);
  const items = candidates.slice(0, settings.claimCandidates);
  const mine = withRepoLock(cfg, "sweep", () =>
    reserveParents(cfg, req.sweepId, parents, ctx.now),
  );
  return {
    config: publicConfig(cfg),
    items,
    waiting: candidates.length - items.length,
    parents: mine,
    liveElsewhere,
    skipped,
  };
}

export { sweep };
