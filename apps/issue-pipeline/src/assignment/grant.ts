// Whether a buddy's assignment still grants it an issue's work
// (`assignment-permission`, #119). Only the repo's configured grantor
// (`assignments.grantor`, `axolotl-logic`) grants or withdraws. The grant is
// the grantor's latest assignment of the buddy's account. Any later change
// by someone else pauses the work item and grants nothing: another account's
// assignment or unassignment, or a comment from someone who isn't trusted.
// So does an issue someone else closed; the landing account's closure is
// the pipeline's own Completion. Only a newer grant by the grantor lifts a pause.
//
// Every fact comes from a fresh read of GitHub (`fresh-reads`): the issue,
// every page of its events and every page of its comments. A failed read or
// a cut-short listing makes the grant unknown, which pauses too: unknown is
// never a grant and never a confirmed withdrawal (`observation-sources`).
//
//   granted   the grantor's assignment stands and nothing paused it since
//   paused    withdrawn, never made, changed by someone else, or unknown
//
// The job (`--assignment`) and the sweep both ask. It writes nothing.

import { z } from "zod";
import type { Config } from "../config.ts";
import { wire } from "../discovery/wire.ts";
import { gh, isAllowedUser } from "../github.ts";
import { OpsError } from "../ops-error.ts";

const USER = z.looseObject({ login: z.string() });
const ISSUE = z.looseObject({
  state: z.string(),
  assignees: z.array(USER),
});
const EVENT = wire(
  z.looseObject({
    id: z.number(),
    event: z.string(),
    actor: USER.nullable(),
    assignee: USER.nullish(),
    createdAt: z.string(),
  }),
);
const COMMENT = wire(
  z.looseObject({ user: USER.nullable(), createdAt: z.string() }),
);
const ASSIGNMENT_EVENTS = new Set(["assigned", "unassigned"]);

type Grant = { granted: true } | { granted: false; why: string };
type Event = z.infer<typeof EVENT>;

// Thrown by a check that finds the work item paused; its message starts
// `paused: `, which the job's line reports.
class AssignmentPaused extends OpsError {}

function same(a: string | null | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

function grantorOf(cfg: Config): string {
  const grantor = cfg.assignments?.grantor;
  if (grantor === undefined) {
    throw new AssignmentPaused(
      `paused: assignment mode isn't enabled for ${cfg.repo} (assignments.grantor)`,
    );
  }
  return grantor;
}

// One complete read: the parsed JSON lines of `endpoint`, every page, or
// null when any page failed, which leaves the listing cut short.
function listing<T>(
  cfg: Config,
  endpoint: string,
  row: z.ZodType<T>,
): T[] | null {
  const args = ["api", "--paginate", endpoint, "--jq", ".[] | @json"];
  const result = gh(cfg, "merge", args, { allowFail: true });
  if (result.code !== 0) {
    return null;
  }
  const rows = z.array(row).safeParse(
    result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line): unknown => JSON.parse(line)),
  );
  if (!rows.success) {
    return null;
  }
  return rows.data;
}

function issueOf(cfg: Config, issue: number): z.infer<typeof ISSUE> | null {
  const args = ["api", `repos/${cfg.repo}/issues/${issue}`];
  const result = gh(cfg, "merge", args, { allowFail: true });
  if (result.code !== 0) {
    return null;
  }
  const parsed = ISSUE.safeParse(JSON.parse(result.stdout));
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

// The grantor's latest assignment event for `login`, or why there is none.
function grantEvent(
  events: readonly Event[],
  login: string,
  grantor: string,
): Event | string {
  const latest = events
    .filter(
      (event) =>
        ASSIGNMENT_EVENTS.has(event.event) &&
        same(event.assignee?.login, login) &&
        same(event.actor?.login, grantor),
    )
    .toSorted((a, b) => a.id - b.id)
    .at(-1);
  if (latest === undefined) {
    return `${grantor} hasn't assigned ${login}`;
  }
  if (latest.event === "unassigned") {
    return `${grantor} withdrew ${login}'s assignment`;
  }
  return latest;
}

// Whether `author` may comment after a grant without pausing it: the
// grantor, either buddy's account, or an allowed collaborator.
function trustedAuthor(
  cfg: Config,
  author: string | undefined,
  grantor: string,
): boolean {
  if (author === undefined) {
    return false;
  }
  return (
    [grantor, cfg.devAccount, cfg.mergeAccount].some((login) =>
      same(author, login),
    ) || isAllowedUser(cfg, author)
  );
}

// Whether the landing account closed the issue last: the pipeline's own
// Completion, not a withdrawal.
function closedByPipeline(cfg: Config, events: readonly Event[]): boolean {
  const closed = events
    .filter((event) => event.event === "closed")
    .toSorted((a, b) => a.id - b.id)
    .at(-1);
  return closed !== undefined && same(closed.actor?.login, cfg.mergeAccount);
}

function assignmentGrant(cfg: Config, issue: number, login: string): Grant {
  const grantor = grantorOf(cfg);
  const repo = `repos/${cfg.repo}/issues/${issue}`;
  const current = issueOf(cfg, issue);
  const events = listing(cfg, `${repo}/events?per_page=100`, EVENT);
  const comments = listing(cfg, `${repo}/comments?per_page=100`, COMMENT);
  if (current === null || events === null || comments === null) {
    return {
      granted: false,
      why: `#${issue}'s assignment couldn't be read in full`,
    };
  }
  if (current.state !== "open" && !closedByPipeline(cfg, events)) {
    return { granted: false, why: `#${issue} is ${current.state}` };
  }
  const grant = grantEvent(events, login, grantor);
  if (typeof grant === "string") {
    return { granted: false, why: grant };
  }
  if (!current.assignees.some((user) => same(user.login, login))) {
    return { granted: false, why: `${login} is no longer assigned` };
  }
  const change = events.find(
    (event) =>
      event.id > grant.id &&
      ASSIGNMENT_EVENTS.has(event.event) &&
      !same(event.actor?.login, grantor),
  );
  if (change !== undefined) {
    const actor = change.actor?.login ?? "an unknown account";
    return {
      granted: false,
      why: `${actor} changed an assignment after ${grantor}'s grant`,
    };
  }
  const comment = comments.find(
    (item) =>
      item.createdAt >= grant.createdAt &&
      !trustedAuthor(cfg, item.user?.login, grantor),
  );
  if (comment !== undefined) {
    const author = comment.user?.login ?? "an unknown account";
    return {
      granted: false,
      why: `untrusted ${author} commented after ${grantor}'s grant`,
    };
  }
  return { granted: true };
}

// Throws AssignmentPaused unless `login`'s assignment still grants `issue`.
function assertGranted(cfg: Config, issue: number, login: string): void {
  const grant = assignmentGrant(cfg, issue, login);
  if (!grant.granted) {
    throw new AssignmentPaused(`paused: ${grant.why}`);
  }
}

export type { Grant };
export { AssignmentPaused, assertGranted, assignmentGrant, listing };
