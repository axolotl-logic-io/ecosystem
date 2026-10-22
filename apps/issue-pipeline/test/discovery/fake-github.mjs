// @ts-check
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach } from "node:test";
import { z } from "zod";
import { COMMENT } from "../../src/comments.ts";
import { EVENT, ISSUE, PULL } from "../../src/discovery/schema.ts";
import { gherkinBody } from "../../src/gherkin-comment.ts";
import { newIssueState } from "../../src/state.ts";
import { trustedInputBytes } from "../../src/trusted-inputs.ts";

/** @type {Set<() => string[]>} */
const pendingReplies = new Set();
afterEach(() => {
  const unused = [...pendingReplies].flatMap((pending) => pending());
  pendingReplies.clear();
  if (unused.length > 0) {
    throw new Error(`unused fake GitHub replies: ${unused.join(", ")}`);
  }
});

// Pagination faults target the endpoint and page, not incidental query order.
/** @param {string} path */
function routePage(path) {
  const url = new URL(path, "https://api.github.com");
  return `${url.pathname}?page=${url.searchParams.get("page") ?? ""}`;
}

const fixture = z
  .object({
    issue: z.unknown(),
    pull: z.unknown(),
    event: z.unknown(),
    teamEvent: z.unknown(),
    review: z.unknown(),
    comment: z.unknown(),
    gherkin: z.unknown(),
  })
  .parse(
    JSON.parse(
      fs.readFileSync(new URL("wire-fixtures.json", import.meta.url), "utf8"),
    ),
  );
const SHA_LENGTH = 40;
const HTTP_MISSING = 404;
const HTTP_COLLABORATOR = 204;
const SHA = "a".repeat(SHA_LENGTH);
const AT = "2026-10-20T00:00:00Z";

/** @param {string} repository */
function configFor(repository) {
  return {
    enabled: true,
    allowRepositories: [repository],
    repositories: [
      {
        repo: repository,
        devAccount: "dev",
        mergeAccount: "merge",
        legacyAccount: "legacy",
        allowedUsers: ["owner", "dev", "merge", "legacy"],
      },
    ],
    workers: [
      {
        repository,
        login: "dev",
        worker: "builder",
        roles: ["development"],
        reviewer: "merge",
      },
      { repository, login: "merge", worker: "checker", roles: ["review"] },
    ],
    requestBudget: 100,
  };
}

/** @param {string} [repository] */
function initialWorld(repository = "axolotl-logic-io/ecosystem") {
  const issue = ISSUE.parse(fixture.issue);
  const pull = PULL.parse(fixture.pull);
  pull.head.repo.fullName = repository;
  pull.base.repo.fullName = repository;
  const config = configFor(repository);
  /** @type {import('../../src/comments.ts').IssueComment[]} */
  const comments = [];
  /** @type {import('../../src/discovery/reads.ts').ReadRequest[]} */
  const requests = [];
  /** @type {Map<string, {status: number, body: unknown, link: string | null}>} */
  const replies = new Map();
  const usedReplies = new Set();
  pendingReplies.add(() =>
    [...replies.keys()].filter((path) => !usedReplies.has(path)),
  );
  const collaborators = new Set(["owner", "legacy"]);
  const assigned = [issue];
  /** @type {import('../../src/discovery/schema.ts').Pull[]} */
  const pulls = [];
  const events = [EVENT.parse(fixture.event)];
  const reviewEvents = [
    {
      ...EVENT.parse(fixture.event),
      id: 21,
      event: "review_requested",
      actor: { login: "dev" },
      requestedReviewer: { login: "merge" },
    },
  ];
  /** @type {unknown[]} */
  const reviews = [];
  const { state, revision, handoff } = savedFor(issue);

  return {
    repository,
    config,
    issue,
    pull,
    comments,
    requests,
    replies,
    usedReplies,
    collaborators,
    assigned,
    pulls,
    events,
    reviewEvents,
    reviews,
    state,
    revision,
    handoff,
  };
}

/** @param {import('../../src/discovery/schema.ts').Issue} issue */
function savedFor(issue) {
  const state = {
    ...newIssueState(1, "author"),
    stage: "review",
    pr: 2,
    branch: "work",
    headSha: SHA,
  };
  const revision = createHash("sha256")
    .update(trustedInputBytes(issue, []))
    .digest("hex");
  state.gherkin = { commentId: 11, rev: 1, inputs: revision };
  /** @type {import("../../src/discovery/schema.ts").Handoff} */
  const handoff = {
    checkpoint: { pr: 2, branch: "work", code: SHA, inputs: revision, at: AT },
    request: 21,
    eventsBefore: [],
    review: null,
  };

  return { state, revision, handoff };
}

/** @param {ReturnType<typeof initialWorld>} hub */
function createSave(hub) {
  const { state, revision, handoff, comments } = hub;
  /** @param {unknown} [raw] */
  return function save(
    raw = {
      ...state,
      coordination: { pending: null, localRecovery: false, handoff },
    },
  ) {
    const receipt = COMMENT.parse(fixture.comment);
    receipt.body = `<!-- agent-pipeline:state\n${JSON.stringify(raw)}\n-->`;
    const gherkin = COMMENT.parse(fixture.gherkin);
    gherkin.body = `<!-- agent-pipeline:comment role=author -->\n<!-- issue-pipeline:1:gherkin -->\n${gherkinBody({ gherkin: "Feature: work", assumptions: [] }, { rev: 1, inputs: revision })}`;
    comments.splice(0, comments.length, receipt, gherkin);
  };
}

/** @param {string} [repository] */
function world(repository = "axolotl-logic-io/ecosystem") {
  const hub = initialWorld(repository);
  /** @param {import('../../src/discovery/reads.ts').ReadRequest} request */
  function read(request) {
    return readHub(hub, request);
  }
  return { ...hub, save: createSave(hub), read };
}

/** @param {ReturnType<typeof initialWorld>} hub @param {string} requested */
function overrideReply(hub, requested) {
  for (const [path, override] of hub.replies) {
    if (routePage(path) === routePage(requested)) {
      hub.usedReplies.add(path);
      return override;
    }
  }
  return null;
}

/**
 * @param {ReturnType<typeof initialWorld>} hub
 * @param {import('../../src/discovery/reads.ts').ReadRequest} request
 */
async function readHub(hub, request) {
  const {
    repository,
    issue,
    comments,
    requests,
    collaborators,
    assigned,
    pulls,
    events,
    reviewEvents,
    reviews,
  } = hub;
  requests.push(request);
  if (request.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("wrong repository");
  }
  if (request.kind === "comment") {
    return readComment(hub, request);
  }
  if (request.method !== "GET") {
    throw new Error("not a GET");
  }
  const override = overrideReply(hub, request.path);
  if (override !== null) {
    return override;
  }
  const url = new URL(`https://api.github.com${request.path}`);
  const route = url.pathname.slice(`/repos/${repository}/`.length);
  let body;
  let status = 200;
  if (route === "issues") {
    body = assigned;
  } else if (route === "pulls") {
    body = pulls;
  } else if (route === "issues/1") {
    body = issue;
  } else if (route === "issues/1/comments") {
    body = comments;
  } else if (route === "issues/1/events") {
    body = events;
  } else if (route === "issues/2/events") {
    body = reviewEvents;
  } else if (route === "pulls/2/reviews") {
    body = reviews;
  } else if (route.startsWith("collaborators/")) {
    body = null;
    status = HTTP_MISSING;
    if (collaborators.has(route.slice("collaborators/".length).toLowerCase())) {
      status = HTTP_COLLABORATOR;
    }
  } else {
    throw new Error(`Unexpected read: ${request.path}`);
  }
  // No fake transport retries or side effects hide requests from the bound.
  return await Promise.resolve({
    status,
    body: structuredClone(body),
    link: null,
  });
}

/**
 * @param {ReturnType<typeof initialWorld>} hub
 * @param {Extract<import('../../src/discovery/reads.ts').ReadRequest, {kind: "comment"}>} request
 */
function readComment(hub, request) {
  const { comments } = hub;
  if (!request.query.startsWith("query")) {
    throw new Error("not a read");
  }
  const item = comments.find((comment) => comment.node_id === request.id);
  return {
    status: 200,
    link: null,
    body: {
      data: {
        node: {
          databaseId: item?.id,
          body: item?.body,
          createdAt: AT,
          updatedAt: AT,
          lastEditedAt: item?.lastEditedAt ?? null,
          author: item?.user,
          editor: item?.editor ?? null,
        },
      },
    },
  };
}

export { AT, fixture, SHA, world };
