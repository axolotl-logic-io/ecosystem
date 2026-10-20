// @ts-check
// GitHub's wire spelling belongs here, not in policy tests.
import {
  EVENT,
  ISSUE,
  PR,
  REVIEW,
} from "../../src/assignment/signal-schema.ts";
import { CODE } from "./world.mjs";

/** @import { World } from './world.mjs' */
const PR_OFFSET = 10_000;
/** @param {World} f @param {number} number @param {string} kind @param {{actor: string, extra?: object}} data */
function event(f, number, kind, { actor, extra = {} }) {
  f.world.sequence += 1;
  const row = EVENT.parse({
    id: f.world.sequence,
    event: kind,
    actor: { login: actor },
    created_at: new Date(f.world.now).toISOString(),
    ...extra,
  });
  f.events.set(number, [...(f.events.get(number) ?? []), row]);
  return row;
}
/** @param {World} f @param {number} number @param {string} actor @param {string} [kind] */
function request(f, number, actor, kind = "review_requested") {
  return event(f, number, kind, {
    actor,
    extra: { requested_reviewer: { login: f.cfg.mergeAccount } },
  });
}
/** @param {World} f @param {number} number @param {string} [author] @param {string} [actor] */
function issue(f, number, author = "alice", actor = "alice") {
  const row = ISSUE.parse({
    number,
    state: "open",
    title: "Work",
    body: "",
    user: { login: author },
    assignees: [{ login: f.cfg.devAccount }],
    labels: [],
  });
  f.issues.set(number, row);
  event(f, number, "assigned", {
    actor,
    extra: { assignee: { login: f.cfg.devAccount } },
  });
  return row;
}
/** @param {World} f @param {number} number */
function pull(f, number) {
  const pr = PR.parse({
    number: number + PR_OFFSET,
    state: "open",
    user: { login: f.cfg.devAccount },
    requested_reviewers: [],
    head: {
      sha: CODE,
      ref: `agent/issue-${number}`,
      repo: { full_name: f.cfg.repo },
    },
    base: { ref: f.cfg.baseBranch, repo: { full_name: f.cfg.repo } },
  });
  f.prs.set(pr.number, pr);
  return pr;
}
/** @param {World} f @param {number} pr @param {string} verdict @param {{body?: string, author?: string, head?: string}} [options] */
function review(f, pr, verdict, options = {}) {
  f.world.sequence += 1;
  const row = REVIEW.parse({
    id: f.world.sequence,
    user: { login: options.author ?? f.cfg.mergeAccount },
    state: verdict,
    commit_id: options.head ?? CODE,
    submitted_at: new Date(f.world.now).toISOString(),
    body: options.body ?? "checked",
  });
  f.reviews.set(pr, [...(f.reviews.get(pr) ?? []), row]);
  clearRequest(f, pr);
  request(
    f,
    pr,
    options.author ?? f.cfg.mergeAccount,
    "review_request_removed",
  );
  return row;
}
/** @param {World} f @param {number} pr */
function clearRequest(f, pr) {
  const row = f.prs.get(pr);
  if (row === undefined) {
    throw new Error("missing fixture PR");
  }
  row.requested_reviewers = [];
}

export { clearRequest, event, issue, pull, request, review };
