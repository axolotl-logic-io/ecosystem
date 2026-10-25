// A fake `gh` executable for the signal tests, answering from the world file
// in FAKE_GH_WORLD and appending each call to FAKE_GH_LOG. It speaks the
// parts of gh and GitHub that signals rely on: `api user`, `api --include
// --method GET` with status lines and Link headers on numbered pages,
// `api graphql` comment provenance, and comment POSTs whose answer can be
// lost after or before they apply.
import fs from "node:fs";
import process from "node:process";
import {
  type FakeComment,
  type FakeIssue,
  readWorld,
  type World,
  writeWorld,
} from "./fake-github-world.ts";

interface Answer {
  status: number;
  body: unknown;
  link: string | null;
}

const UPPER = /[A-Z]/gu;
const ISSUE_PATH = /^repos\/[^/]+\/[^/]+\/issues\/(?<number>\d+)$/u;
const ISSUE_PART =
  /^repos\/[^/]+\/[^/]+\/issues\/(?<number>\d+)\/(?<part>events|comments)$/u;
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

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function env(name: string): string {
  const { [name]: value } = process.env;
  if (value === undefined || value === "") {
    return fail(`fake gh: ${name} is not set`);
  }
  return value;
}

const WORLD_FILE = env("FAKE_GH_WORLD");
const LOG_FILE = env("FAKE_GH_LOG");

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
  const { GH_TOKEN: token = "" } = process.env;
  const found = world.tokens.find((entry) => entry.token === token);
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

function listing(
  world: World,
  path: string,
  query: URLSearchParams,
): unknown[] | null {
  const { number, part } = ISSUE_PART.exec(path)?.groups ?? {};
  if (part !== undefined) {
    const issue = issueOf(world, number);
    if (issue === null) {
      return null;
    }
    if (part === "events") {
      return restEvent(world, issue);
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
      state: "open",
      labels: issue.labels.map((name) => ({ name, color: "ededed" })),
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

function get(world: World, target: string): Answer {
  const url = new URL(`https://api.github.com/${target}`);
  const path = url.pathname.slice(1);
  const page = Number(url.searchParams.get("page") ?? "1");
  const fault = world.faults.find(
    (item) => item.path === path && (item.page === null || item.page === page),
  );
  if (fault !== undefined && fault.link === null) {
    return { status: fault.status, body: { message: "injected" }, link: null };
  }
  const rows = listing(world, path, url.searchParams);
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

function printAnswer(answer: Answer): void {
  const headers = [
    `HTTP/2.0 ${answer.status} ${REASONS.get(answer.status) ?? "Error"}`,
    "Content-Type: application/json; charset=utf-8",
  ];
  if (answer.link !== null) {
    headers.push(`Link: ${answer.link}`);
  }
  process.stdout.write(
    `${headers.join("\r\n")}\r\n\r\n${JSON.stringify(snakeKeys(answer.body))}`,
  );
  if (answer.status >= HTTP_ERRORS) {
    process.stderr.write(`gh: injected (HTTP ${answer.status})\n`);
    process.exit(1);
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

function graphql(world: World, args: readonly string[]): void {
  const fields = fieldsOf(args);
  if (fields.has("id")) {
    process.stdout.write(
      JSON.stringify({ data: { node: node(world, fields.get("id")) } }),
    );
    return;
  }
  const data: Record<string, unknown> = {};
  for (const [name, value] of fields) {
    if (name !== "query") {
      data[name] = node(world, value);
    }
  }
  process.stdout.write(JSON.stringify({ data }));
}

function post(world: World, args: readonly string[]): void {
  const path = args.find((arg) => ISSUE_PART.test(arg)) ?? "";
  const { number } = ISSUE_PART.exec(path)?.groups ?? {};
  const issue = issueOf(world, number);
  const body = fieldsOf(args).get("body");
  if (issue === null || body === undefined) {
    fail("gh: Not Found (HTTP 404)");
  }
  if (world.post === "lost-before-apply") {
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
  world.nextId += 1;
  writeWorld(WORLD_FILE, world);
  if (world.post === "lost-after-apply") {
    fail("gh: HTTP 502: Bad Gateway");
  }
}

function main(args: readonly string[]): void {
  const world = readWorld(WORLD_FILE);
  const shown = args.map((arg) => arg.replace(BODY_FIELD, "body=<record>"));
  fs.appendFileSync(
    LOG_FILE,
    `${JSON.stringify({ login: login(world), args: shown })}\n`,
  );
  if (args[0] !== "api") {
    fail(`fake gh: unsupported command ${args.join(" ")}`);
  }
  if (args[1] === "user" && args.length <= USER_CHECK_ARGS) {
    process.stdout.write(`${login(world)}\n`);
    return;
  }
  if (args[1] === "graphql") {
    graphql(world, args);
    return;
  }
  if (args.includes("POST")) {
    post(world, args);
    return;
  }
  if (
    args[1] === "--include" &&
    args[2] === "--method" &&
    args[3] === "GET" &&
    args[4] !== undefined
  ) {
    printAnswer(get(world, args[4]));
    return;
  }
  fail(`fake gh: unsupported api call ${args.join(" ")}`);
}

main(process.argv.slice(2));
