// The fake GitHub's assignments (#119, #120): each issue's assignees and
// its `assigned`/`unassigned` events, with the account that made each, as
// GitHub's REST API lists them. A test may cut a listing short: gh then
// prints the first page and fails, as `gh api --paginate` does when a later
// page errors.

import type { Answer, World } from "./fake-pipeline-flow-gh-world.ts";
import {
  issueOf,
  now,
  restIssue,
  withWorld,
} from "./fake-pipeline-flow-gh-world.ts";

// An assignment event as the world keeps it.
interface FlowEvent {
  id: number;
  issue: number;
  event: "assigned" | "unassigned" | "closed";
  actor: string;
  assignee: string | null;
  createdAt: string;
}

const CUT_SHORT = "HTTP 403: API rate limit exceeded";

// Records `actor` (un)assigning `login` on issue `n`.
function recordAssignment(
  world: World,
  n: number,
  {
    event,
    login,
    actor,
  }: { event: "assigned" | "unassigned"; login: string; actor: string },
): void {
  const item = issueOf(world, n);
  const assignees = (item.assignees ?? []).filter((each) => each !== login);
  if (event === "assigned") {
    assignees.push(login);
  }
  item.assignees = assignees;
  const events = world.events ?? [];
  events.push({
    id: world.nextId,
    issue: n,
    event,
    actor,
    assignee: login,
    createdAt: now(),
  });
  world.events = events;
  world.nextId += 1;
}

// Records `actor`'s `event` on issue `n` that names no assignee, such as
// closing it.
function recordEvent(
  world: World,
  n: number,
  { event, actor }: { event: "closed"; actor: string },
): void {
  const events = world.events ?? [];
  events.push({
    id: world.nextId,
    issue: n,
    event,
    actor,
    assignee: null,
    createdAt: now(),
  });
  world.events = events;
  world.nextId += 1;
}

// `actor` assigns issue `n` to `login`.
function assignIssue(
  dir: string,
  n: number,
  login: string,
  actor: string,
): void {
  withWorld(dir, (world) =>
    recordAssignment(world, n, { event: "assigned", login, actor }),
  );
}

// `actor` removes `login` from issue `n`.
function unassignIssue(
  dir: string,
  n: number,
  login: string,
  actor: string,
): void {
  withWorld(dir, (world) =>
    recordAssignment(world, n, { event: "unassigned", login, actor }),
  );
}

// Cuts the listing at `route` short, such as `issues/7/events`, or, with
// `cut` false, lets it complete again.
function cutListing(dir: string, route: string, cut = true): void {
  withWorld(dir, (world) => {
    const kept = (world.cutShort ?? []).filter((each) => each !== route);
    if (cut) {
      kept.push(route);
    }
    world.cutShort = kept;
  });
}

function restEvent(item: FlowEvent): Record<string, unknown> {
  let assignee: { login: string } | null = null;
  if (item.assignee !== null) {
    assignee = { login: item.assignee };
  }
  return Object.fromEntries([
    ["id", item.id],
    ["event", item.event],
    ["actor", { login: item.actor }],
    ["assignee", assignee],
    ["created_at", item.createdAt],
  ]);
}

// `rows` as `gh api --paginate … --jq '.[] | @json'` prints them, or, for a
// listing cut short, its first row and a failure.
function listed(world: World, route: string, rows: readonly unknown[]): Answer {
  const lines = rows.map((row) => `${JSON.stringify(row)}\n`);
  if ((world.cutShort ?? []).includes(route)) {
    return { stdout: lines.slice(0, 1).join(""), stderr: CUT_SHORT, code: 1 };
  }
  return { stdout: lines.join("") };
}

// Issue `n`'s events, every page.
function issueEvents(world: World, n: number): Answer {
  issueOf(world, n);
  const rows = (world.events ?? [])
    .filter((each) => each.issue === n)
    .map(restEvent);
  return listed(world, `issues/${n}/events`, rows);
}

// The repo's open issues, every page, each PR's issue marked as GitHub
// marks it.
function openIssues(world: World): Answer {
  const rows = world.issues
    .filter((each) => each.state === "open")
    .map((each) => {
      const row = { ...restIssue(each) };
      if (each.isPull === true) {
        Object.assign(row, Object.fromEntries([["pull_request", {}]]));
      }
      return row;
    });
  return listed(world, "issues", rows);
}

export type { FlowEvent };
export {
  assignIssue,
  cutListing,
  issueEvents,
  listed,
  openIssues,
  recordEvent,
  unassignIssue,
};
