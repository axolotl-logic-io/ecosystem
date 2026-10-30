// The fake `gh` of the signal and buddy flow tests, answering from the
// world the fake GitHub server holds (fake-gh-server.ts) and appending each
// call to the server's call log. It speaks the parts of gh and GitHub that
// signals rely on: `api user`, `api --include --method GET` with status
// lines and Link headers on numbered pages, event listings that can lag
// behind a label removal, `api graphql` comment
// provenance, and comment POSTs whose answer can be lost after or before
// they apply. The buddy flow tests' further gh surface is in
// fake-gh-flow.ts.
import fs from "node:fs";
import {
  answer as answered,
  type Call,
  exit,
  fail,
  print,
  printError,
  type Reply,
  token,
} from "./fake-gh-call.ts";
import { countPoll, flowCall } from "./fake-gh-flow.ts";
import type { FakeComment, FakeIssue, World } from "./fake-github-world.ts";

interface Answer {
  status: number;
  body: unknown;
  link: string | null;
}

const UPPER = /[A-Z]/gu;
const ISSUE_PATH = /^repos\/[^/]+\/[^/]+\/issues\/(?<number>\d+)$/u;
const ISSUE_PART =
  /^repos\/[^/]+\/[^/]+\/issues\/(?<number>\d+)\/(?<part>events|comments)$/u;
const EVENTS_PATH = /^repos\/[^/]+\/[^/]+\/issues\/\d+\/events(?:\?|$)/u;
const PULL_PART =
  /^repos\/[^/]+\/[^/]+\/pulls\/(?<number>\d+)\/(?<part>reviews|comments)$/u;
const ORG_MEMBERSHIP = /^orgs\/(?<org>[^/]+)\/memberships\/(?<login>[^/]+)$/u;
const OWN_MEMBERSHIP = /^user\/memberships\/orgs\/(?<org>[^/]+)$/u;
const USER_BY_ID = /^user\/(?<id>\d+)$/u;
const NODE_ID = /^IC_(?<id>\d+)$/u;
const REPOSITORY_ID = 4242;
// GitHub's issue rows have ids of their own, unlike their numbers.
const ISSUE_ID_SCALE = 1000;
const HTTP_ERRORS = 400;
const REPO_PATH = /^repos\/[^/]+\/[^/]+/u;
const BODY_FIELD = /^body=[\s\S]*$/u;
// `gh api user --jq .login`: the credential check.
const USER_CHECK_ARGS = 4;
// Posted comments are dated from this instant, a second apart.
const POSTED_FROM = Date.parse("2026-10-25T12:00:00Z");
const MS_PER_SECOND = 1000;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const REASONS: ReadonlyMap<number, string> = new Map([
  [HTTP_OK, "OK"],
  [HTTP_NOT_FOUND, "Not Found"],
]);

// GitHub's REST field names, from the camel case the fake keeps.
function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakeKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(UPPER, (letter: string) => `_${letter.toLowerCase()}`),
      snakeKeys(item),
    ]),
  );
}

function login(world: World): string {
  const found = world.tokens.find((entry) => entry.token === token());
  if (found === undefined) {
    return fail("gh: HTTP 401: Bad credentials");
  }
  return found.login;
}

function account(world: World, name: string): World["accounts"][number] {
  const found = world.accounts.find(
    (item) => item.login.toLowerCase() === name.toLowerCase(),
  );
  if (found === undefined) {
    return fail(`fake gh: world has no account ${name}`);
  }
  return found;
}

function issueOf(world: World, number: string | undefined): FakeIssue | null {
  return world.issues.find((item) => String(item.number) === number) ?? null;
}

function restComment(
  world: World,
  issue: FakeIssue,
  item: FakeComment,
): unknown {
  return {
    id: item.id,
    nodeId: `IC_${item.id}`,
    body: item.body,
    user: { login: item.author },
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    issueUrl: `https://api.github.com/repos/${world.repo}/issues/${issue.number}`,
  };
}

function restEvent(world: World, issue: FakeIssue): unknown[] {
  return issue.events.map((item) => {
    let actor: unknown = null;
    if (item.actor !== null) {
      const { login: name, id, type } = account(world, item.actor);
      actor = { login: name, id: item.actorId ?? id, type };
    }
    let label: unknown;
    if (item.label !== null) {
      label = { name: item.label, color: "ededed" };
    }
    let app: unknown = null;
    if (item.viaApp) {
      app = { id: 1, slug: "some-app" };
    }
    return {
      id: item.id,
      nodeId: `LE_${item.id}`,
      url: `https://api.github.com/repos/${world.repo}/issues/events/${item.id}`,
      actor,
      event: item.event,
      commitId: null,
      commitUrl: null,
      createdAt: item.createdAt,
      label,
      performedViaGithubApp: app,
    };
  });
}

function issueState(issue: FakeIssue): "open" | "closed" {
  if (issue.closed === undefined) {
    return "open";
  }
  return "closed";
}

// What GitHub adds to an issue row that is a pull request.
function pullRequestOf(issue: FakeIssue): { pullRequest?: { url: string } } {
  if (issue.pullRequest) {
    return { pullRequest: { url: "https://api.github.com/pulls/1" } };
  }
  return {};
}

function membership(world: World, name: string): Answer {
  const member = world.members.find(
    (item) => item.login.toLowerCase() === name.toLowerCase(),
  );
  if (member === undefined) {
    return {
      status: HTTP_NOT_FOUND,
      body: { message: "Not Found" },
      link: null,
    };
  }
  const user = account(world, member.login);
  const body = {
    url: `https://api.github.com/orgs/${world.organization}/memberships/${user.login}`,
    state: member.state,
    role: member.role,
    organizationUrl: `https://api.github.com/orgs/${world.organization}`,
    user: { login: user.login, id: user.id, type: user.type },
  };
  if (world.organizationObject) {
    return {
      status: HTTP_OK,
      body: { ...body, organization: { login: world.organization, id: 99 } },
      link: null,
    };
  }
  return { status: HTTP_OK, body, link: null };
}

// The REST user GitHub shows for an account's login.
function restUser(world: World, name: string): unknown {
  const { login: user, id, type } = account(world, name);
  return { login: user, id, type };
}

// A PR's reviews or line comments, as the REST API lists them.
function pullListing(
  world: World,
  number: string | undefined,
  part: string,
): unknown[] | null {
  const pull = (world.pulls ?? []).find(
    (item) => String(item.number) === number,
  );
  if (pull === undefined) {
    return null;
  }
  if (part === "reviews") {
    return (pull.reviews ?? []).map((review) => ({
      id: review.id,
      nodeId: `PRR_${review.id}`,
      user: restUser(world, review.author),
      body: review.body,
      state: review.state,
      commitId: review.commitId,
      submittedAt: review.submittedAt,
    }));
  }
  return (pull.reviewComments ?? []).map((comment) => {
    const row = {
      id: comment.id,
      nodeId: `PRRC_${comment.id}`,
      pullRequestReviewId: comment.review,
      user: restUser(world, comment.author),
      path: comment.path,
      line: comment.line,
      commitId: comment.commitId,
      body: comment.body,
      createdAt: comment.createdAt,
    };
    if (comment.inReplyTo === null) {
      return row;
    }
    return { ...row, inReplyToId: comment.inReplyTo };
  });
}

function listing(
  world: World,
  path: string,
  query: URLSearchParams,
  lagging: boolean,
): unknown[] | null {
  const { number: pull, part: pullPart } = PULL_PART.exec(path)?.groups ?? {};
  if (pullPart !== undefined) {
    return pullListing(world, pull, pullPart);
  }
  const { number, part } = ISSUE_PART.exec(path)?.groups ?? {};
  if (part !== undefined) {
    const issue = issueOf(world, number);
    // Every PR is an issue too; the world keeps no conversation on one.
    const isPull = (world.pulls ?? []).some(
      (item) => String(item.number) === number,
    );
    if (issue === null && isPull && part === "comments") {
      return [];
    }
    if (issue === null) {
      return null;
    }
    if (part === "events") {
      const events = restEvent(world, issue);
      if (lagging && issue.events.at(-1)?.event === "unlabeled") {
        return events.slice(0, -1);
      }
      return events;
    }
    return issue.comments.map((item) => restComment(world, issue, item));
  }
  if (path === `repos/${world.repo}/issues/comments`) {
    return world.issues
      .flatMap((issue) => issue.comments.map((item) => ({ issue, item })))
      .sort((a, b) => a.item.id - b.item.id)
      .map(({ issue, item }) => restComment(world, issue, item));
  }
  if (path === `repos/${world.repo}/issues` && query.get("state") === "open") {
    const label = query.get("labels");
    return world.issues
      .filter((issue) => issueState(issue) === "open")
      .filter((issue) => label !== null && issue.labels.includes(label))
      .map((issue) => ({
        number: issue.number,
        id: issue.number * ISSUE_ID_SCALE,
        ...pullRequestOf(issue),
      }));
  }
  return null;
}

function single(world: World, path: string): Answer | null {
  const { org: own } = OWN_MEMBERSHIP.exec(path)?.groups ?? {};
  if (own !== undefined) {
    if (own.toLowerCase() !== world.organization.toLowerCase()) {
      return {
        status: HTTP_NOT_FOUND,
        body: { message: "Not Found" },
        link: null,
      };
    }
    return membership(world, login(world));
  }
  const { org, login: member } = ORG_MEMBERSHIP.exec(path)?.groups ?? {};
  if (org !== undefined && member !== undefined) {
    if (org.toLowerCase() !== world.organization.toLowerCase()) {
      return {
        status: HTTP_NOT_FOUND,
        body: { message: "Not Found" },
        link: null,
      };
    }
    return membership(world, member);
  }
  const { id: byId } = USER_BY_ID.exec(path)?.groups ?? {};
  if (byId !== undefined) {
    const user = world.accounts.find((item) => String(item.id) === byId);
    if (user === undefined) {
      return {
        status: HTTP_NOT_FOUND,
        body: { message: "Not Found" },
        link: null,
      };
    }
    return { status: HTTP_OK, body: user, link: null };
  }
  const { number } = ISSUE_PATH.exec(path)?.groups ?? {};
  const issue = issueOf(world, number);
  if (issue !== null) {
    const body = {
      number: issue.number,
      state: issueState(issue),
      labels: issue.labels.map((name) => ({ name, color: "ededed" })),
      assignees: (issue.assignees ?? []).map((name) => ({ login: name })),
      ...pullRequestOf(issue),
    };
    return { status: HTTP_OK, body, link: null };
  }
  return null;
}

// GitHub names a repository by its id in page links.
function pageUrl(rest: string, query: URLSearchParams, page: number): string {
  const params = new URLSearchParams(query);
  params.set("page", String(page));
  return `<https://api.github.com/${rest}?${params.toString()}>`;
}

function pageLink(
  path: string,
  query: URLSearchParams,
  page: number,
  last: number,
): string | null {
  const rest = path.replace(REPO_PATH, `repositories/${REPOSITORY_ID}`);
  const links: string[] = [];
  if (page < last) {
    links.push(
      `${pageUrl(rest, query, page + 1)}; rel="next"`,
      `${pageUrl(rest, query, last)}; rel="last"`,
    );
  }
  if (page > 1) {
    links.push(
      `${pageUrl(rest, query, 1)}; rel="first"`,
      `${pageUrl(rest, query, page - 1)}; rel="prev"`,
    );
  }
  if (links.length === 0) {
    return null;
  }
  return links.join(", ");
}

function get(world: World, target: string, lagging: boolean): Answer {
  const url = new URL(`https://api.github.com/${target}`);
  const path = url.pathname.slice(1);
  const page = Number(url.searchParams.get("page") ?? "1");
  const fault = world.faults.find(
    (item) => item.path === path && (item.page === null || item.page === page),
  );
  if (fault !== undefined && fault.link === null) {
    return { status: fault.status, body: { message: "injected" }, link: null };
  }
  const rows = listing(world, path, url.searchParams, lagging);
  if (rows !== null) {
    const size = world.pageSize;
    const last = Math.max(1, Math.ceil(rows.length / size));
    let link = pageLink(path, url.searchParams, page, last);
    if (fault !== undefined) {
      ({ link } = fault);
    }
    return {
      status: HTTP_OK,
      body: rows.slice((page - 1) * size, page * size),
      link,
    };
  }
  return (
    single(world, path) ?? {
      status: HTTP_NOT_FOUND,
      body: { message: "Not Found" },
      link: null,
    }
  );
}

// Whether this read of `target` lags behind the issue's newest event,
// spending one of the world's lagging reads when it does.
function lag(
  world: World,
  target: string,
  commit: (world: World) => void,
): boolean {
  const lagging = world.timelineLag;
  if (lagging === undefined || !EVENTS_PATH.test(target)) {
    return false;
  }
  if (lagging > 1) {
    world.timelineLag = lagging - 1;
  } else {
    Reflect.deleteProperty(world, "timelineLag");
  }
  commit(world);
  return true;
}

function printAnswer(answer: Answer): void {
  const headers = [
    `HTTP/2.0 ${answer.status} ${REASONS.get(answer.status) ?? "Error"}`,
    "Content-Type: application/json; charset=utf-8",
  ];
  if (answer.link !== null) {
    headers.push(`Link: ${answer.link}`);
  }
  print(
    `${headers.join("\r\n")}\r\n\r\n${JSON.stringify(snakeKeys(answer.body))}`,
  );
  if (answer.status >= HTTP_ERRORS) {
    printError(`gh: injected (HTTP ${answer.status})\n`);
    exit(1);
  }
}

function fieldsOf(args: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();
  args.forEach((arg, at) => {
    const value = args[at + 1];
    if ((arg === "-f" || arg === "-F") && value !== undefined) {
      const split = value.indexOf("=");
      fields.set(value.slice(0, split), value.slice(split + 1));
    }
  });
  return fields;
}

function node(world: World, id: string | undefined): unknown {
  const { id: commentId } = NODE_ID.exec(id ?? "")?.groups ?? {};
  for (const issue of world.issues) {
    const item = issue.comments.find(
      (comment) => String(comment.id) === commentId,
    );
    if (item !== undefined) {
      let editor: unknown = null;
      let lastEditedAt: string | null = null;
      if (item.editor !== null) {
        editor = { login: item.editor };
        lastEditedAt = item.createdAt;
      }
      return {
        databaseId: item.id,
        body: item.body,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        lastEditedAt,
        author: { login: item.author },
        editor,
      };
    }
  }
  return null;
}

const THREAD_PULL = /pullRequest\(number:(?<number>\d+)\)/u;

function graphql(world: World, args: readonly string[]): void {
  const fields = fieldsOf(args);
  const query = fields.get("query") ?? "";
  if (query.includes("reviewThreads")) {
    const { number } = THREAD_PULL.exec(query)?.groups ?? {};
    const pull = world.pulls?.find((item) => String(item.number) === number);
    if (pull === undefined) {
      fail("pull not found");
    }
    const nodes = (pull.reviewComments ?? [])
      .filter((comment) => comment.inReplyTo === null)
      .map((comment) => ({
        isResolved: comment.resolved ?? false,
        comments: { nodes: [{ databaseId: comment.id }] },
      }));
    print(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    );
    return;
  }
  if (fields.has("id")) {
    print(JSON.stringify({ data: { node: node(world, fields.get("id")) } }));
    return;
  }
  const data: Record<string, unknown> = {};
  for (const [name, value] of fields) {
    if (name !== "query") {
      data[name] = node(world, value);
    }
  }
  print(JSON.stringify({ data }));
}

function post(
  world: World,
  args: readonly string[],
  commit: (world: World) => void,
): void {
  const path = args.find((arg) => ISSUE_PART.test(arg)) ?? "";
  const { number } = ISSUE_PART.exec(path)?.groups ?? {};
  const issue = issueOf(world, number);
  const body = fieldsOf(args).get("body");
  if (issue === null || body === undefined) {
    fail("gh: Not Found (HTTP 404)");
  }
  const once = world.failPostOnceContaining;
  if (once !== undefined && body.includes(once)) {
    Reflect.deleteProperty(world, "failPostOnceContaining");
    commit(world);
    fail("gh: HTTP 502: Bad Gateway");
  }
  const marked = world.failWritesContaining;
  if (
    world.post === "lost-before-apply" ||
    (marked !== undefined && body.includes(marked))
  ) {
    fail("gh: HTTP 502: Bad Gateway");
  }
  issue.comments.push({
    id: world.nextId,
    author: login(world),
    body,
    editor: null,
    createdAt: new Date(
      POSTED_FROM + world.nextId * MS_PER_SECOND,
    ).toISOString(),
  });
  const id = world.nextId;
  world.nextId += 1;
  const { race } = world;
  if (race?.after.every((part) => body.includes(part)) === true) {
    issue.comments.push({
      id: world.nextId,
      ...race.comment,
      editor: null,
      createdAt: new Date(
        POSTED_FROM + world.nextId * MS_PER_SECOND,
      ).toISOString(),
    });
    world.nextId += 1;
    Reflect.deleteProperty(world, "race");
  }
  commit(world);
  if (world.post === "lost-after-apply") {
    fail("gh: HTTP 502: Bad Gateway");
  }
  if (args.includes(".id")) {
    print(`${id}\n`);
  }
}

// Fails `gh issue close` with a 502 before it applies while the world has
// closes left to fail, spending one.
function failIssueClose(
  world: World,
  args: readonly string[],
  commit: (world: World) => void,
): void {
  const failing = world.failIssueCloses;
  if (args[0] !== "issue" || args[1] !== "close" || failing === undefined) {
    return;
  }
  if (failing > 1) {
    world.failIssueCloses = failing - 1;
  } else {
    Reflect.deleteProperty(world, "failIssueCloses");
  }
  commit(world);
  fail("gh: HTTP 502: Bad Gateway");
}

// Fails a `gh pr merge` that applied with a 502 while the world has merge
// answers left to lose, spending one, as a dropped connection would.
function loseMergeResponse(
  world: World,
  args: readonly string[],
  commit: (world: World) => void,
): void {
  const losing = world.loseMergeResponses;
  if (args[0] !== "pr" || args[1] !== "merge" || losing === undefined) {
    return;
  }
  if (losing > 1) {
    world.loseMergeResponses = losing - 1;
  } else {
    Reflect.deleteProperty(world, "loseMergeResponses");
  }
  commit(world);
  fail("gh: HTTP 502: Bad Gateway");
}

function call(
  world: World,
  args: readonly string[],
  log: string,
  commit: (world: World) => void,
): void {
  const shown = args.map((arg) => arg.replace(BODY_FIELD, "body=<record>"));
  fs.appendFileSync(
    log,
    `${JSON.stringify({ login: login(world), args: shown })}\n`,
  );
  failIssueClose(world, args, commit);
  const flow = flowCall(world, args, login(world));
  if (flow.handled) {
    if (flow.changed) {
      commit(world);
    }
    loseMergeResponse(world, args, commit);
    return;
  }
  if (args[0] !== "api") {
    fail(`fake gh: unsupported command ${args.join(" ")}`);
  }
  if (args[1] === "user" && args.length <= USER_CHECK_ARGS) {
    print(`${login(world)}\n`);
    return;
  }
  if (args[1] === "graphql") {
    graphql(world, args);
    return;
  }
  if (args.includes("POST")) {
    post(world, args, commit);
    return;
  }
  if (
    args[1] === "--include" &&
    args[2] === "--method" &&
    args[3] === "GET" &&
    args[4] !== undefined
  ) {
    if (countPoll(world, args[4])) {
      commit(world);
    }
    printAnswer(get(world, args[4], lag(world, args[4], commit)));
    return;
  }
  fail(`fake gh: unsupported api call ${args.join(" ")}`);
}

// Answers `invocation`'s args, run with its token and standard input, from
// `world`, logging the call to its `log`. `commit` keeps the world as the
// call has changed it so far; changes made after the last commit are lost,
// as they were when a gh process exited without writing its world back.
function gh(
  world: World,
  invocation: Call & { args: readonly string[]; log: string },
  commit: (world: World) => void,
): Reply {
  return answered(invocation, () =>
    call(world, invocation.args, invocation.log, commit),
  );
}

export { gh };
