// Claims of a task's start label, read from the issue's label timeline. A
// start is one `labeled` event of `start:X`; the next `unlabeled` event of
// it is the claim that takes that start, and its actor is the buddy that
// runs it. Each buddy has its own GitHub account, so the actor names the
// buddy.
//
// The running label `agent:X:running` stays on the issue while any claim
// of X is open: made, but with no end comment from the account that made
// it. A removal of the running label by an account that has never posted
// an end comment of X is a person clearing it; claims before that removal
// count as settled, so a crashed run holds the label only until a person
// removes it.
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { IssueGitHub, LabelEvent } from "./issue-github.ts";
import { type EndMark, endMarkOf } from "./markers.ts";
import { Stopped } from "./stopped.ts";

type Claim =
  | { state: "won"; start: number | null; claim: number }
  | { state: "lost" }
  | { state: "stopped" }
  | { state: "unconfirmed"; start: number | null; reason: string };

// Waits for `ms` milliseconds.
type Sleep = (ms: number) => Promise<void>;

function startLabel(task: string): string {
  return `start:${task}`;
}

function runningLabel(task: string): string {
  return `agent:${task}:running`;
}

function sameAccount(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function isEvent(
  event: LabelEvent,
  kind: LabelEvent["kind"],
  label: string,
): boolean {
  return event.kind === kind && event.label === label;
}

// The `labeled` event of the start that `events[at]`, an `unlabeled` event,
// took, or null when the timeline doesn't show one.
function startBefore(
  events: readonly LabelEvent[],
  at: number,
  label: string,
): number | null {
  for (let index = at - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.label === label) {
      if (event.kind === "labeled") {
        return event.id;
      }
      return null;
    }
  }
  return null;
}

// This account's claim among `events` after index `after`, or null when
// the timeline doesn't show one yet.
function ownClaim(
  events: readonly LabelEvent[],
  after: number,
  label: string,
  account: string,
): { start: number | null; claim: number } | null {
  for (let index = after + 1; index < events.length; index += 1) {
    const event = events[index];
    if (
      event !== undefined &&
      isEvent(event, "unlabeled", label) &&
      sameAccount(event.actor, account)
    ) {
      return { start: startBefore(events, index, label), claim: event.id };
    }
  }
  return null;
}

// Takes `start:task` for this account. The removal only succeeds while the
// label is on the issue, so a removal that GitHub accepts consumed a start
// no other buddy took; the timeline confirms which one. `waits` are the
// pauses between rereads while the timeline doesn't yet show the removal.
async function claimStart(
  github: IssueGitHub,
  task: string,
  waits: readonly number[],
  sleep: Sleep,
): Promise<Claim> {
  const label = startLabel(task);
  let removed: "removed" | "absent";
  let noted: number;
  let start: number | null = null;
  try {
    const before = github.labelEvents();
    noted = before.findLastIndex((event) => isEvent(event, "labeled", label));
    start = before[noted]?.id ?? null;
    removed = github.removeLabel(label);
  } catch (error) {
    if (error instanceof Stopped) {
      return { state: "stopped" };
    }
    throw error;
  }
  if (removed === "absent") {
    return { state: "lost" };
  }
  const found = await confirm({ github, label, noted }, waits, sleep);
  if (found.state === "won") {
    return { state: "won", start: found.start, claim: found.claim };
  }
  return { state: "unconfirmed", start, reason: found.reason };
}

// Rereads the timeline until it shows this account's claim after index
// `noted`, pausing for each of `waits` in turn.
async function confirm(
  removal: { github: IssueGitHub; label: string; noted: number },
  waits: readonly number[],
  sleep: Sleep,
): Promise<
  | { state: "won"; start: number | null; claim: number }
  | { state: "unconfirmed"; reason: string }
> {
  const { github, label, noted } = removal;
  let reason = "the issue timeline doesn't show the removal";
  try {
    const found = ownClaim(github.labelEvents(), noted, label, github.account);
    if (found !== null) {
      return { state: "won", ...found };
    }
  } catch (error) {
    if (!(error instanceof OpsError)) {
      throw error;
    }
    reason = error.message;
  }
  const [wait, ...rest] = waits;
  if (wait === undefined) {
    return { state: "unconfirmed", reason };
  }
  await sleep(wait);
  return confirm(removal, rest, sleep);
}

interface EndComment extends EndMark {
  author: string | null;
}

// The claims of `task` that are still open on the issue.
function openClaims(github: IssueGitHub, task: string): number[] {
  const start = startLabel(task);
  const running = runningLabel(task);
  const events = github.labelEvents();
  const ends = github.comments().flatMap((comment): EndComment[] => {
    const mark = endMarkOf(comment.body, task);
    if (mark === null) {
      return [];
    }
    return [{ ...mark, author: comment.author }];
  });
  const enders = ends.map((end) => end.author);
  const cleared = events.findLastIndex(
    (event) =>
      isEvent(event, "unlabeled", running) &&
      !enders.some((author) => sameAccount(author, event.actor)),
  );
  const open: number[] = [];
  events.forEach((event, at) => {
    if (at <= cleared || !isEvent(event, "unlabeled", start)) {
      return;
    }
    const taken = startBefore(events, at, start);
    const ended = ends.some(
      (end) =>
        sameAccount(end.author, event.actor) &&
        (end.claim === event.id || (end.claim === null && end.start === taken)),
    );
    if (!ended) {
      open.push(event.id);
    }
  });
  return open;
}

// Removes `agent:task:running` once no claim of `task` but `own` is open,
// and puts it back if a claim opened while it was being removed. Run after
// the end comment of claim `own`, which GitHub may not list yet.
function unmark(github: IssueGitHub, task: string, own: number): void {
  const label = runningLabel(task);
  function others(): number[] {
    return openClaims(github, task).filter((claim) => claim !== own);
  }
  if (others().length > 0) {
    return;
  }
  github.removeLabel(label, { ending: true });
  if (others().length > 0) {
    github.addLabel(label, { ending: true });
  }
}

export type { Claim, Sleep };
export { claimStart, openClaims, runningLabel, startLabel, unmark };
