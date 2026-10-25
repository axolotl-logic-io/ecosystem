// @ts-check
// The fake GitHub's assignments (#119, #120): each issue's assignees and
// its `assigned`/`unassigned` events, with the account that made each, as
// GitHub's REST API lists them. A test may cut a listing short: gh then
// prints the first page and fails, as `gh api --paginate` does when a later
// page errors.
import { issueOf, now, withWorld } from "./fake-pipeline-flow-gh-world.mjs";

/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").Answer} Answer */

/**
 * An assignment event as the world keeps it.
 * @typedef {object} FlowEvent
 * @property {number} id
 * @property {number} issue
 * @property {"assigned" | "unassigned"} event
 * @property {string} actor
 * @property {string} assignee
 * @property {string} createdAt
 */

const CUT_SHORT = "HTTP 403: API rate limit exceeded";

/**
 * Records `actor` (un)assigning `login` on issue `n`.
 * @param {World} world @param {number} n
 * @param {{ event: "assigned" | "unassigned", login: string, actor: string }} change
 */
function recordAssignment(world, n, { event, login, actor }) {
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

/**
 * `actor` assigns issue `n` to `login`.
 * @param {string} dir @param {number} n @param {string} login @param {string} actor
 */
function assignIssue(dir, n, login, actor) {
  withWorld(dir, (world) =>
    recordAssignment(world, n, { event: "assigned", login, actor }),
  );
}

/**
 * `actor` removes `login` from issue `n`.
 * @param {string} dir @param {number} n @param {string} login @param {string} actor
 */
function unassignIssue(dir, n, login, actor) {
  withWorld(dir, (world) =>
    recordAssignment(world, n, { event: "unassigned", login, actor }),
  );
}

/**
 * Cuts the listing at `route` short, such as `issues/7/events`, or, with
 * `cut` false, lets it complete again.
 * @param {string} dir @param {string} route @param {boolean} [cut]
 */
function cutListing(dir, route, cut = true) {
  withWorld(dir, (world) => {
    const kept = (world.cutShort ?? []).filter((each) => each !== route);
    if (cut) {
      kept.push(route);
    }
    world.cutShort = kept;
  });
}

/** @param {FlowEvent} item */
function restEvent(item) {
  return Object.fromEntries([
    ["id", item.id],
    ["event", item.event],
    ["actor", { login: item.actor }],
    ["assignee", { login: item.assignee }],
    ["created_at", item.createdAt],
  ]);
}

/**
 * `rows` as `gh api --paginate … --jq '.[] | @json'` prints them, or, for a
 * listing cut short, its first row and a failure.
 * @param {World} world @param {string} route @param {readonly unknown[]} rows
 * @returns {Answer}
 */
function listed(world, route, rows) {
  const lines = rows.map((row) => `${JSON.stringify(row)}\n`);
  if ((world.cutShort ?? []).includes(route)) {
    return { stdout: lines.slice(0, 1).join(""), stderr: CUT_SHORT, code: 1 };
  }
  return { stdout: lines.join("") };
}

/**
 * Issue `n`'s events, every page.
 * @param {World} world @param {number} n @returns {Answer}
 */
function issueEvents(world, n) {
  issueOf(world, n);
  const rows = (world.events ?? [])
    .filter((each) => each.issue === n)
    .map(restEvent);
  return listed(world, `issues/${n}/events`, rows);
}

export { assignIssue, cutListing, issueEvents, listed, unassignIssue };
